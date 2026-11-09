import { createHash } from "node:crypto"
import { posix } from "node:path"
import { inferFileMediaType } from "../../blob-storage/media-type"
import type { BlobStorage } from "../../blob-storage/types"
import type { ArtifactFile } from "../../storage/artifacts/types"
import { ARTIFACT_LIMITS } from "../limits"
import { isLiveTextPath, type LiveFile, type LiveFiles } from "./document"

// A version's files as the live layer reads them, and back. Reading takes each text file's words
// from blob storage; storing puts back only the texts that changed, so a write keeps the
// references of every file it did not touch.

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * A version's files as text where their path says they are and their bytes are UTF-8 text no
 * larger than a file may be; any other is held as its reference.
 */
export async function readLiveFiles(
  blobStorage: Pick<BlobStorage, "open">,
  files: readonly ArtifactFile[]
): Promise<Map<string, LiveFile>> {
  const read = await Promise.all(
    files.map(async ({ path, file }): Promise<[string, LiveFile]> => {
      if (!isLiveTextPath(path) || file.sizeBytes > ARTIFACT_LIMITS.maxFileBytes) {
        return [path, { file }]
      }

      const bytes = new Uint8Array(
        await new Response(await blobStorage.open(file.blobId)).arrayBuffer()
      )
      try {
        return [path, { text: strictUtf8.decode(bytes) }]
      } catch {
        return [path, { file }]
      }
    })
  )
  return new Map(read.sort(([left], [right]) => (left < right ? -1 : 1)))
}

/**
 * Files to publish from what the live layer holds: a text that `known` already holds at its path
 * keeps its reference, and any other is stored, with the media type its path had.
 */
export async function storeLiveFiles(
  blobStorage: Pick<BlobStorage, "put">,
  files: LiveFiles,
  known: readonly ArtifactFile[]
): Promise<ArtifactFile[]> {
  const byPath = new Map(known.map((entry) => [entry.path, entry.file]))

  return Promise.all(
    [...files].map(async ([path, file]): Promise<ArtifactFile> => {
      if ("file" in file) return { path, file: { ...file.file } }

      const body = new TextEncoder().encode(file.text)
      const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`
      const before = byPath.get(path)
      if (before?.digest === digest) return { path, file: { ...before } }

      const fileName = posix.basename(path)
      const stored = await blobStorage.put({
        body,
        expectedSizeBytes: body.byteLength,
        fileName,
        mediaType: before?.mediaType ?? inferFileMediaType(fileName, body),
      })
      return { path, file: stored }
    })
  )
}

/** Whether two sets of files are the same files, path by path and byte for byte. */
export function sameArtifactFiles(
  left: readonly ArtifactFile[],
  right: readonly ArtifactFile[]
): boolean {
  if (left.length !== right.length) return false
  const digests = new Map(left.map((entry) => [entry.path, entry.file.digest]))
  return right.every((entry) => digests.get(entry.path) === entry.file.digest)
}
