import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import {
  assertExpectedBlobSize,
  assertValidExpectedBlobSize,
  type BlobByteRange,
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  blobDigestHex,
  blobIdFromDigest,
  createFileRef,
  type FileRef,
  type PutBlobInput,
  type RangeReadableBlobStorage,
  streamBlobBody,
} from "@sixb/core"
import type { LocalBlobStorageOptions } from "./types"

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
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
    assertValidExpectedBlobSize(input.expectedSizeBytes, "BlobLocal")
    await mkdir(this.sha256RootPath(), { recursive: true })
    const tempPath = join(this.sha256RootPath(), `.tmp-${randomUUID()}`)
    const hash = createHash("sha256")
    let sizeBytes = 0

    try {
      const trackedBody = streamBlobBody(input.body).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            hash.update(chunk)
            sizeBytes += chunk.byteLength
            if (input.expectedSizeBytes !== undefined && sizeBytes > input.expectedSizeBytes) {
              assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobLocal")
            }
            controller.enqueue(chunk)
          },
        })
      )
      const destination = Writable.toWeb(createWriteStream(tempPath, { flags: "wx" }))

      await trackedBody.pipeTo(destination, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobLocal")

      const digest = `sha256:${hash.digest("hex")}` as const
      const hex = blobDigestHex(digest)
      const contentPath = this.contentPathForHex(hex)
      const info: BlobInfo = {
        blobId: blobIdFromDigest(digest),
        digest,
        sizeBytes,
      }

      if (await pathExists(contentPath)) {
        await rm(tempPath, { force: true })
      } else {
        try {
          await rename(tempPath, contentPath)
        } catch (error) {
          if (!(await pathExists(contentPath))) {
            throw error
          }
          await rm(tempPath, { force: true })
        }
      }

      return createFileRef(input, info)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async open(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const contentPath = await this.requireContentPath(blobId)
    // Stream from disk rather than buffering the whole blob into memory (mirrors openRange).
    return toByteReadableStream(createReadStream(contentPath))
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    const contentPath = await this.requireContentPath(blobId)
    return toByteReadableStream(
      createReadStream(contentPath, {
        start: range.start,
        end: range.endInclusive,
      })
    )
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

function toByteReadableStream(
  stream: ReturnType<typeof createReadStream>
): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream, {
    strategy: {
      highWaterMark: stream.readableHighWaterMark,
      size(chunk: Buffer) {
        return chunk.byteLength
      },
    },
  }) as unknown as ReadableStream<Uint8Array>
}
