import { BlobStorageError } from "./errors"
import type { BlobInfo, BlobStorage, FileRef, PutBlobInput } from "./types"
import { blobIdFromDigest, computeBlobDigest, createFileRef, readBlobBody } from "./utils"

type StoredBlob = {
  readonly bytes: Uint8Array
  readonly info: BlobInfo
}

export class InMemoryBlobStorage implements BlobStorage {
  private readonly blobsById = new Map<string, StoredBlob>()

  async put(input: PutBlobInput): Promise<FileRef> {
    const bytes = await readBlobBody(input.body)
    const digest = computeBlobDigest(bytes)
    const blobId = blobIdFromDigest(digest)

    let stored = this.blobsById.get(blobId)
    if (!stored) {
      stored = {
        bytes,
        info: {
          blobId,
          digest,
          sizeBytes: bytes.byteLength,
        },
      }
      this.blobsById.set(blobId, stored)
    }

    return createFileRef(input, stored.info)
  }

  async open(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const stored = this.blobsById.get(blobId)
    if (!stored) {
      throw new BlobStorageError(`[BlobStorage] Unknown blob '${blobId}'`)
    }

    return new Blob([new Uint8Array(stored.bytes)]).stream()
  }

  async stat(blobId: string): Promise<BlobInfo | null> {
    const stored = this.blobsById.get(blobId)
    return stored ? { ...stored.info } : null
  }
}
