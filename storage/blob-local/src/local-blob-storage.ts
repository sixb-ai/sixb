import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import {
  type BlobByteRange,
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  blobDigestHex,
  blobIdFromDigest,
  computeBlobDigest,
  createFileRef,
  type FileRef,
  type PutBlobInput,
  type RangeReadableBlobStorage,
  readBlobBody,
} from "@sixb/core"
import type { LocalBlobStorageOptions } from "./types"

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function hexFromBlobId(blobId: string): string | null {
  if (!/^blob_[a-f0-9]{64}$/.test(blobId)) {
    return null
  }

  return blobId.slice("blob_".length)
}

export class LocalBlobStorage implements BlobStorage, RangeReadableBlobStorage {
  private readonly basePath: string

  constructor(options: LocalBlobStorageOptions = {}) {
    this.basePath = resolve(options.basePath ?? ".sixb")
  }

  async put(input: PutBlobInput): Promise<FileRef> {
    const bytes = await readBlobBody(input.body)
    const digest = computeBlobDigest(bytes)
    const hex = blobDigestHex(digest)
    const info: BlobInfo = {
      blobId: blobIdFromDigest(digest),
      digest,
      sizeBytes: bytes.byteLength,
    }
    const contentPath = this.contentPathForHex(hex)

    await mkdir(this.sha256RootPath(), { recursive: true })
    if (!(await pathExists(contentPath))) {
      // Write to a temp file first so interrupted uploads do not leave a partial object at the digest path.
      const tempPath = join(this.sha256RootPath(), `.tmp-${randomUUID()}`)
      await writeFile(tempPath, bytes)
      await rename(tempPath, contentPath)
    }

    return createFileRef(input, info)
  }

  async open(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const contentPath = await this.requireContentPath(blobId)
    const bytes = await readFile(contentPath)
    return new Blob([new Uint8Array(bytes)]).stream()
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    const contentPath = await this.requireContentPath(blobId)
    return Readable.toWeb(
      createReadStream(contentPath, {
        start: range.start,
        end: range.endInclusive,
      })
    ) as unknown as ReadableStream<Uint8Array>
  }

  async stat(blobId: string): Promise<BlobInfo | null> {
    const hex = hexFromBlobId(blobId)
    if (!hex) {
      return null
    }

    const contentPath = this.contentPathForHex(hex)
    if (!(await pathExists(contentPath))) {
      return null
    }

    const contentStat = await stat(contentPath)
    return {
      blobId,
      digest: `sha256:${hex}`,
      sizeBytes: contentStat.size,
    }
  }

  private async requireContentPath(blobId: string): Promise<string> {
    const hex = hexFromBlobId(blobId)
    if (!hex) {
      throw new BlobStorageError(`[BlobLocal] Invalid blob id '${blobId}'`)
    }

    const contentPath = this.contentPathForHex(hex)
    if (!(await pathExists(contentPath))) {
      throw new BlobStorageError(`[BlobLocal] Unknown blob '${blobId}'`)
    }

    return contentPath
  }

  private sha256RootPath(): string {
    return join(this.basePath, "blobs", "sha256")
  }

  private contentPathForHex(hex: string): string {
    return join(this.sha256RootPath(), hex)
  }
}
