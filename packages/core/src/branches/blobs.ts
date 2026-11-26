import { BlobStorageError } from "../blob-storage/errors"
import { jsonPointerSegment } from "../blob-storage/file-content"
import type {
  BlobByteRange,
  BlobInfo,
  BlobStorage,
  RangeReadableBlobStorage,
} from "../blob-storage/types"
import { isFileRef, supportsDirectUpload, supportsRangeRead } from "../blob-storage/validation"
import type { ObjectType } from "../ontology/types"
import type { ObjectStorage } from "../storage"
import type { BranchRuntime } from "./runtime"

/** Where a copied object holds a file: production serves it from there, as the person. */
interface FileHolder {
  readonly objectTypeId: string
  readonly primaryId: string
  /** The file's JSON pointer in the object, as production's file route takes it. */
  readonly path: string
}

const HOLDERS_PAGE = 1_000
/** A blob no copied object holds is looked for again after this long, not on every read. */
const HOLDERS_STALE_MS = 30_000

/**
 * A branch's files, for everything on it that reads them: actions, agent turns, model inputs.
 * What the branch writes is its own, here. The files of the objects it copied stay in production:
 * a read finds the copied object that holds the file and reads it through production's object
 * file route, with the branch's credential, as the person who copied it.
 */
export function branchBlobStorage(input: {
  readonly local: BlobStorage
  readonly runtime: BranchRuntime
  readonly projectId: string
  readonly objects: Pick<ObjectStorage, "listByPrimaryIdPage">
  readonly objectTypes: () => readonly ObjectType[]
}): BlobStorage {
  const { local, runtime } = input
  let holders: { readonly byBlob: Map<string, FileHolder>; readonly at: number } | undefined
  let indexing: Promise<Map<string, FileHolder>> | undefined

  const index = async () => {
    const byBlob = new Map<string, FileHolder>()
    for (const objectType of input.objectTypes()) {
      const fileProperties = objectType.properties
        .filter((property) => JSON.stringify(property).includes('"fileRef"'))
        .map((property) => property.id)
      if (fileProperties.length === 0) continue

      for (let after: string | undefined, more = true; more; ) {
        const page = await input.objects.listByPrimaryIdPage({
          projectId: input.projectId,
          objectTypeId: objectType.id,
          ...(after === undefined ? {} : { afterPrimaryId: after }),
          limit: HOLDERS_PAGE,
        })
        for (const row of page.objects) {
          for (const propertyId of fileProperties) {
            const at = `/properties/${jsonPointerSegment(propertyId)}`
            for (const [blobId, path] of filesIn(row.properties[propertyId], at)) {
              if (!byBlob.has(blobId)) {
                byBlob.set(blobId, {
                  objectTypeId: row.objectTypeId,
                  primaryId: row.primaryId,
                  path,
                })
              }
            }
          }
        }
        after = page.nextPrimaryId
        more = after !== undefined
      }
    }
    return byBlob
  }

  const holderOf = async (blobId: string): Promise<FileHolder | undefined> => {
    const fresh = holders && Date.now() - holders.at < HOLDERS_STALE_MS
    if (holders?.byBlob.has(blobId) || fresh) return holders?.byBlob.get(blobId)

    indexing ??= index().finally(() => {
      indexing = undefined
    })
    const byBlob = await indexing
    holders = { byBlob, at: Date.now() }
    return byBlob.get(blobId)
  }

  const fromProduction = async (blobId: string, method: "GET" | "HEAD", range?: BlobByteRange) => {
    const holder = await holderOf(blobId)
    if (!holder) return null

    const base = runtime.production.url.endsWith("/")
      ? runtime.production.url
      : `${runtime.production.url}/`
    const url = new URL(
      `api/objects/${encodeURIComponent(holder.objectTypeId)}/${encodeURIComponent(holder.primaryId)}/files/content`,
      base
    )
    url.searchParams.set("path", holder.path)
    // The file's own bytes: a length production states for them, not for a compressed body.
    const headers = new Headers({
      authorization: await runtime.production.authorization(),
      "accept-encoding": "identity",
    })
    if (range) headers.set("range", `bytes=${range.start}-${range.endInclusive}`)

    const response = await fetch(url, { method, headers })
    if (response.ok) return response
    await response.body?.cancel()
    return null
  }

  const missing = (blobId: string) =>
    new BlobStorageError(
      `[Sixb] Blob '${blobId}' is neither on this branch nor in production for the person who copied it.`
    )

  const branchBlobs: BlobStorage & Partial<RangeReadableBlobStorage> = {
    put: (blob) => local.put(blob),

    async stat(blobId): Promise<BlobInfo | null> {
      const own = await local.stat(blobId)
      if (own) return own

      const response = await fromProduction(blobId, "HEAD")
      const sizeBytes = Number(response?.headers.get("content-length"))
      if (!response || !Number.isSafeInteger(sizeBytes) || !blobId.startsWith("blob_")) return null
      return { blobId, digest: `sha256:${blobId.slice("blob_".length)}`, sizeBytes }
    },

    async open(blobId) {
      if (await local.stat(blobId)) return local.open(blobId)

      const response = await fromProduction(blobId, "GET")
      if (!response?.body) throw missing(blobId)
      return response.body
    },

    async openRange(blobId, range) {
      if (supportsRangeRead(local) && (await local.stat(blobId))) {
        return local.openRange(blobId, range)
      }

      const response = await fromProduction(blobId, "GET", range)
      if (!response?.body) throw missing(blobId)
      return response.body
    },

    ...(local.close ? { close: () => local.close?.() } : {}),
  }

  // What the branch uploads stays its own: direct uploads go to its storage, as they did.
  if (supportsDirectUpload(local)) {
    return Object.assign(branchBlobs, {
      createUpload: local.createUpload.bind(local),
      signUploadPart: local.signUploadPart.bind(local),
      completeUpload: local.completeUpload.bind(local),
      abortUpload: local.abortUpload.bind(local),
    })
  }
  return branchBlobs
}

/** Every file in a property's value, with its JSON pointer from `at`. */
function* filesIn(value: unknown, at: string): Generator<readonly [string, string]> {
  if (isFileRef(value)) {
    yield [value.blobId, at]
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* filesIn(item, `${at}/${index}`)
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield* filesIn(item, `${at}/${jsonPointerSegment(key)}`)
    }
  }
}
