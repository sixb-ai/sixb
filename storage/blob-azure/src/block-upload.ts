import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  assertExpectedBlobSize,
  type BlobDigest,
  BlobStorageError,
} from "@sixb/core/blob-storage/server"

export const MAX_BLOCKS = 50_000

export interface BlockUploadResult {
  readonly digest: BlobDigest
  readonly sizeBytes: number
  readonly blockIds: string[]
}

interface BlockUploadInput {
  readonly stream: ReadableStream<Uint8Array>
  readonly blockSizeBytes: number
  readonly concurrency: number
  readonly expectedSizeBytes?: number
  readonly signal?: AbortSignal
  readonly stage: (id: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>
}

/** Hash in source order; only provider-owned, replayable buffers reach the SDK. */
export async function uploadBlocks(input: BlockUploadInput): Promise<BlockUploadResult> {
  const controller = new AbortController()
  const { signal } = controller
  const reader = input.stream.getReader()
  const hash = createHash("sha256")
  const active = new Set<Promise<void>>()
  const blockIds: string[] = []
  let sizeBytes = 0
  let buffer: Uint8Array | undefined
  let buffered = 0

  const cancelSource = () => {
    // Cancellation must wake a pending read even when the source's cancel hook fails.
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  const abort = () => controller.abort(input.signal?.reason)
  signal.addEventListener("abort", cancelSource, { once: true })
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()

  const waitForCapacity = async () => {
    while (active.size >= input.concurrency) await Promise.race(active)
    signal.throwIfAborted()
  }

  const stage = (bytes: Uint8Array) => {
    if (blockIds.length === MAX_BLOCKS) {
      throw new BlobStorageError(
        "[BlobAzure] Upload exceeds 50,000 blocks; increase blockSizeBytes."
      )
    }
    const id = Buffer.from(String(blockIds.length).padStart(5, "0")).toString("base64")
    blockIds.push(id)
    const task = Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return input.stage(id, bytes, signal)
      })
      .catch((error: unknown) => controller.abort(error))
      .finally(() => active.delete(task))
    active.add(task)
  }

  try {
    signal.throwIfAborted()
    while (true) {
      await waitForCapacity()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break

      sizeBytes += value.byteLength
      if (input.expectedSizeBytes !== undefined && sizeBytes > input.expectedSizeBytes) {
        assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobAzure")
      }
      hash.update(value)
      let offset = 0
      while (offset < value.byteLength) {
        await waitForCapacity()
        buffer ??= new Uint8Array(input.blockSizeBytes)
        const count = Math.min(buffer.byteLength - buffered, value.byteLength - offset)
        buffer.set(value.subarray(offset, offset + count), buffered)
        buffered += count
        offset += count
        if (buffered === buffer.byteLength) {
          stage(buffer)
          buffer = undefined
          buffered = 0
        }
      }
    }

    assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobAzure")
    if (buffer && buffered > 0) {
      await waitForCapacity()
      stage(buffer.subarray(0, buffered))
    }
    await Promise.all(active)
    signal.throwIfAborted()
    return { digest: `sha256:${hash.digest("hex")}`, sizeBytes, blockIds }
  } catch (error) {
    controller.abort(error)
    throw signal.reason
  } finally {
    // Wait for requests before the caller deletes staging, including on failure.
    await Promise.all(active)
    input.signal?.removeEventListener("abort", abort)
    signal.removeEventListener("abort", cancelSource)
    reader.releaseLock()
  }
}
