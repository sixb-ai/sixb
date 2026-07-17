import { createHash } from "node:crypto"
import type { BlobDigest } from "@sixb/core"
import { assertExpectedBlobSize } from "@sixb/core/blob-storage/server"

export interface S3StreamingWriter {
  write(chunk: Uint8Array): number | Promise<number>
  end(error?: Error): number | Promise<number>
}

export interface S3StreamUploadResult {
  readonly digest: BlobDigest
  readonly sizeBytes: number
}

interface S3StreamUploadInput {
  readonly stream: ReadableStream<Uint8Array>
  readonly writer: S3StreamingWriter
  readonly expectedSizeBytes?: number
  readonly signal?: AbortSignal
}

function errorFrom(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason
  }

  return new Error(typeof reason === "string" ? reason : "S3 upload failed")
}

function waitWithSignal<T>(operation: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return Promise.resolve(operation)
  }

  signal.throwIfAborted()

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })

    void Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

export async function writeBlobStreamToS3(
  input: S3StreamUploadInput
): Promise<S3StreamUploadResult> {
  const hash = createHash("sha256")
  let sizeBytes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let writerFinalization: Promise<void> | undefined

  const finalizeWriter = (error?: Error): Promise<void> => {
    if (!writerFinalization) {
      try {
        writerFinalization = Promise.resolve(input.writer.end(error)).then(() => undefined)
      } catch (writerError) {
        writerFinalization = Promise.reject(writerError)
      }
    }

    return writerFinalization
  }

  const cancelUpload = () => {
    const reason = input.signal?.reason
    void reader?.cancel(reason).catch(() => undefined)
    void finalizeWriter(errorFrom(reason)).catch(() => undefined)
  }

  try {
    input.signal?.throwIfAborted()
    reader = input.stream.getReader()
    input.signal?.addEventListener("abort", cancelUpload, { once: true })
    input.signal?.throwIfAborted()

    while (true) {
      const { done, value } = await waitWithSignal(reader.read(), input.signal)
      input.signal?.throwIfAborted()
      if (done) {
        break
      }

      hash.update(value)
      sizeBytes += value.byteLength
      if (input.expectedSizeBytes !== undefined && sizeBytes > input.expectedSizeBytes) {
        assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobS3")
      }

      await waitWithSignal(input.writer.write(value), input.signal)
    }

    assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobS3")
    input.signal?.throwIfAborted()
    await waitWithSignal(finalizeWriter(), input.signal)
    input.signal?.throwIfAborted()

    return {
      digest: `sha256:${hash.digest("hex")}`,
      sizeBytes,
    }
  } catch (error) {
    await reader?.cancel(error).catch(() => undefined)
    await finalizeWriter(errorFrom(error)).catch(() => undefined)
    throw error
  } finally {
    input.signal?.removeEventListener("abort", cancelUpload)
    reader?.releaseLock()
  }
}
