import { SixbError } from "../errors"
import { blobIdFromDigest } from "./derive"
import type {
  BlobByteRange,
  BlobInfo,
  BlobStorage,
  FileRef,
  PutBlobInput,
  RangeReadableBlobStorage,
} from "./types"
import {
  assertExpectedBlobSize,
  assertValidExpectedBlobSize,
  computeBlobDigest,
  createFileRef,
  readBlobBody,
} from "./utils"

type StoredBlob = {
  readonly bytes: Uint8Array
  readonly info: BlobInfo
}

export class InMemoryBlobStorage implements BlobStorage, RangeReadableBlobStorage {
  private readonly blobsById = new Map<string, StoredBlob>()

  async put(input: PutBlobInput): Promise<FileRef> {
    assertValidExpectedBlobSize(input.expectedSizeBytes)
    const bytes = await readBlobBody(input.body, input.signal)
    assertExpectedBlobSize(input.expectedSizeBytes, bytes.byteLength, "BlobStorage")
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
    const stored = this.requireStoredBlob(blobId)
    return new Blob([new Uint8Array(stored.bytes)]).stream()
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    const stored = this.requireStoredBlob(blobId)
    const bytes = stored.bytes.slice(range.start, range.endInclusive + 1)
    return new Blob([bytes]).stream()
  }

  async stat(blobId: string): Promise<BlobInfo | null> {
    const stored = this.blobsById.get(blobId)
    return stored ? { ...stored.info } : null
  }

  private requireStoredBlob(blobId: string): StoredBlob {
    const stored = this.blobsById.get(blobId)
    if (!stored) {
      throw new SixbError("storage.blob_failed", `[BlobStorage] Unknown blob '${blobId}'`)
    }

    return stored
  }
}
