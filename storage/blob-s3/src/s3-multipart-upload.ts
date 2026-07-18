import { createHash } from "node:crypto"
import type { BlobDigest } from "@sixb/core"
import { assertExpectedBlobSize, BlobStorageError } from "@sixb/core/blob-storage/server"

const RETRY_BASE_DELAY_MS = 250
const RETRY_MAX_DELAY_MS = 2_000

export interface S3UploadPart {
  readonly partNumber: number
  readonly etag: string
}

interface S3UploadObjectInput {
  readonly key: string
  readonly body: Uint8Array
  readonly contentMd5: string
  readonly mediaType?: string
  readonly signal?: AbortSignal
}

interface S3CreateMultipartUploadInput {
  readonly key: string
  readonly mediaType?: string
  readonly signal?: AbortSignal
}

interface S3UploadPartInput {
  readonly key: string
  readonly uploadId: string
  readonly partNumber: number
  readonly body: Uint8Array
  readonly contentMd5: string
  readonly signal?: AbortSignal
}

interface S3CompleteMultipartUploadInput {
  readonly key: string
  readonly uploadId: string
  readonly parts: readonly S3UploadPart[]
  readonly signal?: AbortSignal
}

interface S3AbortMultipartUploadInput {
  readonly key: string
  readonly uploadId: string
}

export interface S3UploadApi {
  putObject(input: S3UploadObjectInput): Promise<void>
  createMultipartUpload(input: S3CreateMultipartUploadInput): Promise<string>
  uploadPart(input: S3UploadPartInput): Promise<string>
  completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void>
  abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void>
}

export interface S3StreamUploadResult {
  readonly digest: BlobDigest
  readonly sizeBytes: number
}

interface S3StreamUploadInput {
  readonly stream: ReadableStream<Uint8Array>
  readonly api: S3UploadApi
  readonly key: string
  readonly partSizeBytes: number
  readonly concurrency: number
  readonly retries: number
  readonly expectedSizeBytes?: number
  readonly signal?: AbortSignal
  readonly mediaType?: string
  readonly retryDelay?: (failedAttempt: number, signal?: AbortSignal) => Promise<void>
}

interface TrackedPartUpload {
  readonly promise: Promise<S3UploadPart>
}

export async function uploadBlobStreamToS3(
  input: S3StreamUploadInput
): Promise<S3StreamUploadResult> {
  const hash = createHash("sha256")
  const reader = input.stream.getReader()
  const activeUploads = new Set<Promise<S3UploadPart>>()
  const allUploads: TrackedPartUpload[] = []
  const initialBufferSize = Math.min(
    input.partSizeBytes,
    input.expectedSizeBytes ?? input.partSizeBytes
  )
  let currentBuffer: Uint8Array | undefined
  let currentLength = 0
  let pendingSinglePart: Uint8Array | undefined
  let allocatedFirstBuffer = false
  let uploadId: string | undefined
  let nextPartNumber = 1
  let sizeBytes = 0
  let partUploadFailed = false
  let partUploadError: unknown

  const cancelSource = () => {
    void reader.cancel(input.signal?.reason).catch(() => undefined)
  }

  const throwPartUploadError = () => {
    if (partUploadFailed) {
      throw partUploadError
    }
  }

  const waitForUploadCapacity = async () => {
    throwPartUploadError()
    while (activeUploads.size >= input.concurrency) {
      await Promise.race(activeUploads)
      throwPartUploadError()
    }
  }

  const beginMultipartUpload = async () => {
    if (uploadId !== undefined) return

    input.signal?.throwIfAborted()
    uploadId = await input.api.createMultipartUpload({
      key: input.key,
      mediaType: input.mediaType,
      signal: input.signal,
    })
    if (uploadId.length === 0) {
      throw new BlobStorageError("[BlobS3] S3 did not return a multipart upload id.")
    }
  }

  const schedulePart = async (body: Uint8Array) => {
    await waitForUploadCapacity()
    input.signal?.throwIfAborted()
    if (uploadId === undefined) {
      throw new BlobStorageError("[BlobS3] Multipart upload was not initialized.")
    }
    const currentUploadId = uploadId

    const partNumber = nextPartNumber
    nextPartNumber += 1
    const promise = retryUpload(
      () =>
        input.api.uploadPart({
          key: input.key,
          uploadId: currentUploadId,
          partNumber,
          body,
          contentMd5: md5Base64(body),
          signal: input.signal,
        }),
      input.retries,
      input.signal,
      input.retryDelay
    )
      .then((etag) => ({ partNumber, etag }))
      .catch((error) => {
        if (!partUploadFailed) {
          partUploadFailed = true
          partUploadError = error
        }
        throw error
      })
      .finally(() => {
        activeUploads.delete(promise)
      })

    activeUploads.add(promise)
    allUploads.push({ promise })
    // Every rejection is observed immediately even if the producer is still reading the source.
    void promise.catch(() => undefined)
  }

  const ensureCurrentBuffer = async () => {
    if (currentBuffer !== undefined) return

    await waitForUploadCapacity()
    const bufferSize = allocatedFirstBuffer ? input.partSizeBytes : initialBufferSize
    allocatedFirstBuffer = true
    currentBuffer = new Uint8Array(bufferSize)
    currentLength = 0
  }

  input.signal?.addEventListener("abort", cancelSource, { once: true })

  try {
    input.signal?.throwIfAborted()

    while (true) {
      throwPartUploadError()
      if (currentBuffer === undefined && pendingSinglePart === undefined) {
        await waitForUploadCapacity()
      }

      const { done, value } = await waitWithSignal(reader.read(), input.signal)
      input.signal?.throwIfAborted()
      throwPartUploadError()
      if (done) break

      hash.update(value)
      sizeBytes += value.byteLength
      if (input.expectedSizeBytes !== undefined && sizeBytes > input.expectedSizeBytes) {
        assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobS3")
      }

      let offset = 0
      while (offset < value.byteLength) {
        throwPartUploadError()

        if (pendingSinglePart !== undefined && uploadId === undefined) {
          await beginMultipartUpload()
          await schedulePart(pendingSinglePart)
          pendingSinglePart = undefined
        }

        await ensureCurrentBuffer()
        if (!currentBuffer) {
          throw new BlobStorageError("[BlobS3] Could not allocate an S3 upload part buffer.")
        }

        const copied = Math.min(currentBuffer.byteLength - currentLength, value.byteLength - offset)
        currentBuffer.set(value.subarray(offset, offset + copied), currentLength)
        currentLength += copied
        offset += copied

        if (currentLength === input.partSizeBytes) {
          const completedBuffer = currentBuffer
          currentBuffer = undefined
          currentLength = 0

          if (uploadId === undefined) {
            pendingSinglePart = completedBuffer
          } else {
            await schedulePart(completedBuffer)
          }
        }
      }
    }

    assertExpectedBlobSize(input.expectedSizeBytes, sizeBytes, "BlobS3")
    input.signal?.throwIfAborted()
    throwPartUploadError()

    if (uploadId === undefined) {
      const body =
        pendingSinglePart ?? currentBuffer?.subarray(0, currentLength) ?? new Uint8Array()
      await retryUpload(
        () =>
          input.api.putObject({
            key: input.key,
            body,
            contentMd5: md5Base64(body),
            mediaType: input.mediaType,
            signal: input.signal,
          }),
        input.retries,
        input.signal,
        input.retryDelay
      )
    } else {
      if (currentLength > 0 && currentBuffer) {
        await schedulePart(currentBuffer.subarray(0, currentLength))
      }

      const parts = await Promise.all(allUploads.map(({ promise }) => promise))
      input.signal?.throwIfAborted()
      await input.api.completeMultipartUpload({
        key: input.key,
        uploadId,
        parts,
        signal: input.signal,
      })
    }

    input.signal?.throwIfAborted()
    return {
      digest: `sha256:${hash.digest("hex")}`,
      sizeBytes,
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    await Promise.allSettled(allUploads.map(({ promise }) => promise))
    if (uploadId !== undefined) {
      await input.api.abortMultipartUpload({ key: input.key, uploadId }).catch(() => undefined)
    }
    throw error
  } finally {
    input.signal?.removeEventListener("abort", cancelSource)
    reader.releaseLock()
  }
}

function md5Base64(value: Uint8Array): string {
  return createHash("md5").update(value).digest("base64")
}

async function retryUpload<T>(
  operation: () => Promise<T>,
  retries: number,
  signal: AbortSignal | undefined,
  retryDelay: S3StreamUploadInput["retryDelay"]
): Promise<T> {
  for (let failedAttempt = 0; ; failedAttempt += 1) {
    signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      if (failedAttempt >= retries || signal?.aborted || !isRetryableS3UploadError(error)) {
        throw error
      }

      await (retryDelay ?? defaultRetryDelay)(failedAttempt + 1, signal)
    }
  }
}

export function isRetryableS3UploadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  const record = error as Record<string, unknown>
  const name = stringValue(record.name) ?? stringValue(record.code) ?? stringValue(record.Code)
  if (
    name === "AbortError" ||
    name === "AccessDenied" ||
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    name === "BadDigest" ||
    name === "EntityTooSmall" ||
    name === "InvalidPart" ||
    name === "InvalidPartOrder" ||
    name === "NoSuchUpload"
  ) {
    return false
  }

  const metadata = record.$metadata as { readonly httpStatusCode?: unknown } | undefined
  const status = metadata?.httpStatusCode ?? record.statusCode ?? record.status
  if (typeof status === "number") {
    return (
      status === 400 ||
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    )
  }

  if (record.$retryable !== undefined || error instanceof TypeError) return true
  if (
    name === "TimeoutError" ||
    name === "RequestTimeout" ||
    name === "ECONNRESET" ||
    name === "ETIMEDOUT" ||
    name === "EPIPE" ||
    name === "ECONNREFUSED" ||
    name === "ENETUNREACH" ||
    name === "EAI_AGAIN"
  ) {
    return true
  }

  return record.cause === undefined ? false : isRetryableS3UploadError(record.cause)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

async function defaultRetryDelay(failedAttempt: number, signal?: AbortSignal): Promise<void> {
  const maximum = Math.min(RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1), RETRY_MAX_DELAY_MS)
  await abortableDelay(Math.floor(Math.random() * maximum), signal)
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (delayMs === 0) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      complete()
    }
    const timer = setTimeout(() => finish(resolve), delayMs)
    const onAbort = () => finish(() => reject(signal?.reason))
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function waitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation

  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void operation.then(
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
