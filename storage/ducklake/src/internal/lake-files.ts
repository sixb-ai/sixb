import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { LakeFile, LakeFileRange } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import { S3Client, type S3File, type S3Options } from "bun"
import type { DuckDbSecretOptions, DuckLakeStorageOptions } from "../types"

/** Where a slice's copies of files with deleted rows are served from, under the route. */
export const COPIES_PREFIX = "sixb-branch-copies/"

/**
 * Production's lake files, as the route that serves them to branches reads them: a local data
 * path is streamed from disk, an S3-compatible one (S3, R2, GCS) through production with its own
 * credentials. Nothing here writes, deletes or lists a file of the lake itself.
 *
 * Copies of files with deleted rows sit beside the data path, never under it: DuckLake's orphan
 * search lists the data path and would delete them. For `.../lake/` they are in
 * `.../lake-branch-copies/`.
 *
 * S3 files are proxied rather than redirected to presigned URLs. Measured on 539 MB of 1 MiB
 * ranges, a redirect saves the API about 1 ms of CPU per MB, and the branch reads no faster:
 * bandwidth decides. A redirect would also need every branch's machine to reach the bucket, and
 * hand it a URL that reads the whole file.
 */
export class LakeFiles {
  readonly copiesRoot: string
  private readonly s3: S3Client | undefined
  private readonly sizes = new Map<string, number>()

  constructor(
    options: Pick<DuckLakeStorageOptions, "secrets">,
    private readonly dataPath: string
  ) {
    this.copiesRoot = copiesRootOf(dataPath)

    const scheme = /^([a-z0-9]+):\/\//i.exec(dataPath)?.[1]?.toLowerCase()
    if (scheme !== undefined && scheme !== "file" && !OBJECT_STORES.has(scheme)) {
      throw new LakeStorageError(
        `[SixbDuckLake] A branch reads production's files from a local data path or S3, R2 or GCS; '${dataPath}' is neither.`
      )
    }
    this.s3 =
      scheme !== undefined && OBJECT_STORES.has(scheme)
        ? s3Client(options.secrets ?? [], dataPath)
        : undefined
  }

  /** A file by the path the route serves it under, or null when there is none. */
  async open(path: string): Promise<LakeFile | null> {
    assertServedPath(path)

    const copy = path.startsWith(COPIES_PREFIX)
    const root = copy ? this.copiesRoot : this.dataPath
    const location = `${root}${copy ? path.slice(COPIES_PREFIX.length) : path}`
    return this.s3 ? this.openObject(location) : openLocalFile(location, root)
  }

  /** Where the copy `name` is written, as DuckDB names it. */
  copyLocation(name: string): string {
    return `${this.copiesRoot}${name}`
  }

  async prepareCopies(): Promise<void> {
    if (!this.s3) await mkdir(localPath(this.copiesRoot), { recursive: true })
  }

  async copyExists(name: string): Promise<boolean> {
    if (this.s3) return this.objectFile(this.copyLocation(name)).exists()
    return Bun.file(localPath(this.copyLocation(name))).exists()
  }

  /** The copies there are, with when each was written and its size. */
  async listCopies(): Promise<readonly LakeCopy[]> {
    if (this.s3) {
      const prefix = objectKey(this.copiesRoot)
      const copies: LakeCopy[] = []
      let startAfter: string | undefined
      for (;;) {
        const page = await this.s3.list({ prefix, ...(startAfter ? { startAfter } : {}) })
        for (const object of page.contents ?? []) {
          copies.push({
            name: object.key.slice(prefix.length),
            writtenAt: new Date(object.lastModified ?? 0),
            sizeBytes: object.size ?? 0,
          })
        }
        if (!page.isTruncated || !page.contents?.length) return copies
        startAfter = page.contents[page.contents.length - 1]?.key
      }
    }

    const root = localPath(this.copiesRoot)
    const names = await readdir(root).catch(() => [] as string[])
    return Promise.all(
      names.map(async (name) => {
        const stats = await stat(join(root, name))
        return { name, writtenAt: stats.mtime, sizeBytes: stats.size }
      })
    )
  }

  async deleteCopy(name: string): Promise<void> {
    if (this.s3) await this.objectFile(this.copyLocation(name)).delete()
    else await rm(localPath(this.copyLocation(name)), { force: true })
  }

  private async openObject(location: string): Promise<LakeFile | null> {
    const file = this.objectFile(location)

    // Every range of a scan asks for the size of a file that never changes.
    let size = this.sizes.get(location)
    if (size === undefined) {
      try {
        size = (await file.stat()).size
      } catch (error) {
        if (isMissingObject(error)) return null
        throw error
      }
      if (this.sizes.size >= SIZES_KEPT) this.sizes.delete(this.sizes.keys().next().value as string)
      this.sizes.set(location, size)
    }

    return { sizeBytes: size, read: (range) => sliced(file, range).stream() }
  }

  private objectFile(location: string): S3File {
    if (!this.s3) throw new LakeStorageError("[SixbDuckLake] This lake's files are local.")
    return this.s3.file(objectKey(location))
  }
}

export interface LakeCopy {
  readonly name: string
  readonly writtenAt: Date
  readonly sizeBytes: number
}

const OBJECT_STORES = new Set(["s3", "r2", "gcs", "gs"])
const SIZES_KEPT = 4_096

/** A relative path under the data path, as the catalog names a file. */
export function assertServedPath(path: string): void {
  const segments = path.split("/")
  if (
    path.length === 0 ||
    path.length > 1024 ||
    /[\\\0]/.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LakeStorageError(`[SixbDuckLake] '${path}' is not a path under the lake's data path.`)
  }
}

function copiesRootOf(dataPath: string): string {
  const trimmed = dataPath.replace(/\/+$/, "")
  if (/^[a-z0-9]+:\/\/[^/]+$/i.test(trimmed)) {
    throw new LakeStorageError(
      `[SixbDuckLake] Production's dataPath '${dataPath}' is a bucket's root. Give it a prefix, such as '${trimmed}/lake/', so the copies branches read can sit beside it.`
    )
  }
  return `${trimmed}-branch-copies/`
}

async function openLocalFile(location: string, root: string): Promise<LakeFile | null> {
  const base = resolve(localPath(root))
  const full = resolve(localPath(location))
  if (!full.startsWith(`${base}${sep}`)) return null

  const file = Bun.file(full)
  if (!(await file.exists())) return null

  return { sizeBytes: file.size, read: (range) => sliced(file, range).stream() }
}

function sliced<TFile extends { slice(start: number, end: number): TFile }>(
  file: TFile,
  range: LakeFileRange | undefined
): TFile {
  return range === undefined ? file : file.slice(range.start, range.endInclusive + 1)
}

function localPath(location: string): string {
  return location.replace(/^file:\/\//, "")
}

function objectKey(location: string): string {
  return new URL(location.replace(/^(gs|gcs|r2):/, "s3:")).pathname.replace(/^\//, "")
}

/** One client, with the credentials DuckDB reads the data path with. */
function s3Client(secrets: readonly DuckDbSecretOptions[], dataPath: string): S3Client {
  const bucket = new URL(dataPath.replace(/^(gs|gcs|r2):/, "s3:")).hostname
  const secret = secrets.find(
    (candidate) =>
      candidate.type !== "azure" &&
      (candidate.scope === undefined || dataPath.startsWith(candidate.scope))
  )
  if (secret === undefined || secret.type === "azure") return new S3Client({ bucket })

  const protocol = secret.useSsl === false ? "http" : "https"
  const endpoint =
    secret.endpoint !== undefined
      ? `${protocol}://${secret.endpoint}`
      : secret.type === "r2" && secret.accountId !== undefined
        ? `https://${secret.accountId}.r2.cloudflarestorage.com`
        : secret.type === "gcs"
          ? "https://storage.googleapis.com"
          : undefined

  const options: S3Options = {
    bucket,
    ...(secret.keyId === undefined ? {} : { accessKeyId: secret.keyId }),
    ...(secret.secret === undefined ? {} : { secretAccessKey: secret.secret }),
    ...(secret.sessionToken === undefined ? {} : { sessionToken: secret.sessionToken }),
    ...(secret.region === undefined ? {} : { region: secret.region }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(secret.urlStyle === "vhost" ? { virtualHostedStyle: true } : {}),
  }
  return new S3Client(options)
}

function isMissingObject(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "NoSuchKey" || error.code === "ERR_S3_FILE_NOT_FOUND")
  )
}
