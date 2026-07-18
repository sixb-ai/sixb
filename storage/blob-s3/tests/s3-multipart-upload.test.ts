import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import {
  isRetryableS3UploadError,
  type S3UploadApi,
  uploadBlobStreamToS3,
} from "../src/s3-multipart-upload"

const encoder = new TextEncoder()

type PutObjectInput = Parameters<S3UploadApi["putObject"]>[0]
type CreateMultipartUploadInput = Parameters<S3UploadApi["createMultipartUpload"]>[0]
type UploadPartInput = Parameters<S3UploadApi["uploadPart"]>[0]
type CompleteMultipartUploadInput = Parameters<S3UploadApi["completeMultipartUpload"]>[0]
type AbortMultipartUploadInput = Parameters<S3UploadApi["abortMultipartUpload"]>[0]

class RecordingUploadApi implements S3UploadApi {
  readonly puts: PutObjectInput[] = []
  readonly creates: CreateMultipartUploadInput[] = []
  readonly parts: UploadPartInput[] = []
  readonly completes: CompleteMultipartUploadInput[] = []
  readonly aborts: AbortMultipartUploadInput[] = []

  async putObject(input: PutObjectInput): Promise<void> {
    this.puts.push({ ...input, body: new Uint8Array(input.body) })
  }

  async createMultipartUpload(input: CreateMultipartUploadInput): Promise<string> {
    this.creates.push(input)
    return "upload-1"
  }

  async uploadPart(input: UploadPartInput): Promise<string> {
    this.parts.push({ ...input, body: new Uint8Array(input.body) })
    return `"etag-${input.partNumber}"`
  }

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<void> {
    this.completes.push(input)
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void> {
    this.aborts.push(input)
  }
}

describe("uploadBlobStreamToS3", () => {
  test("uses one bounded PutObject for bodies no larger than one part", async () => {
    const api = new RecordingUploadApi()
    const bytes = encoder.encode("hello")

    const result = await uploadBlobStreamToS3({
      stream: streamFrom([bytes.subarray(0, 2), bytes.subarray(2)]),
      api,
      key: "sixb/uploads/put-1/object",
      partSizeBytes: 8,
      concurrency: 2,
      retries: 3,
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
    })

    expect(result).toEqual({
      digest: computeBlobDigest(bytes),
      sizeBytes: bytes.byteLength,
    })
    expect(api.creates).toHaveLength(0)
    expect(api.puts).toHaveLength(1)
    expect(api.puts[0]?.body).toEqual(bytes)
    expect(api.puts[0]?.contentMd5).toBe(createHash("md5").update(bytes).digest("base64"))
    expect(api.puts[0]?.mediaType).toBe("text/plain")
  })

  test("uploads ordered parts with bounded concurrency", async () => {
    const api = new RecordingUploadApi()
    const bytes = encoder.encode("abcdefghijkl")
    let activeUploads = 0
    let maximumActiveUploads = 0

    api.uploadPart = async (input: UploadPartInput) => {
      api.parts.push({ ...input, body: new Uint8Array(input.body) })
      activeUploads += 1
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads)
      await Bun.sleep(input.partNumber === 1 ? 10 : 1)
      activeUploads -= 1
      return `"etag-${input.partNumber}"`
    }

    const result = await uploadBlobStreamToS3({
      stream: streamFrom([bytes]),
      api,
      key: "sixb/uploads/put-2/object",
      partSizeBytes: 4,
      concurrency: 2,
      retries: 0,
    })

    expect(result.digest).toBe(computeBlobDigest(bytes))
    expect(api.puts).toHaveLength(0)
    expect(api.creates).toHaveLength(1)
    expect(api.parts.map((part) => part.body)).toEqual([
      encoder.encode("abcd"),
      encoder.encode("efgh"),
      encoder.encode("ijkl"),
    ])
    expect(maximumActiveUploads).toBe(2)
    expect(api.completes).toHaveLength(1)
    expect(api.completes[0]?.parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ])
  })

  test("retries replayable parts up to the configured limit", async () => {
    const api = new RecordingUploadApi()
    const attempts = new Map<number, number>()
    const retryDelays: number[] = []

    api.uploadPart = async (input: UploadPartInput) => {
      const attempt = (attempts.get(input.partNumber) ?? 0) + 1
      attempts.set(input.partNumber, attempt)
      if (input.partNumber === 1 && attempt < 3) {
        throw Object.assign(new Error("temporary S3 failure"), {
          $metadata: { httpStatusCode: 503 },
        })
      }
      return `"etag-${input.partNumber}"`
    }

    await uploadBlobStreamToS3({
      stream: streamFrom([encoder.encode("abcde")]),
      api,
      key: "sixb/uploads/put-3/object",
      partSizeBytes: 4,
      concurrency: 2,
      retries: 2,
      retryDelay: async (failedAttempt) => {
        retryDelays.push(failedAttempt)
      },
    })

    expect(attempts.get(1)).toBe(3)
    expect(attempts.get(2)).toBe(1)
    expect(retryDelays).toEqual([1, 2])
    expect(api.aborts).toHaveLength(0)
  })

  test("cancels the source and aborts multipart state on a permanent part failure", async () => {
    const api = new RecordingUploadApi()
    let sourceCancelled = false
    api.uploadPart = async () => {
      throw Object.assign(new Error("forbidden"), { $metadata: { httpStatusCode: 403 } })
    }

    const upload = uploadBlobStreamToS3({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("abcde"))
        },
        cancel() {
          sourceCancelled = true
        },
      }),
      api,
      key: "sixb/uploads/put-4/object",
      partSizeBytes: 4,
      concurrency: 1,
      retries: 3,
      retryDelay: async () => {
        throw new Error("permanent errors must not retry")
      },
    })

    await expect(upload).rejects.toThrow("forbidden")
    expect(sourceCancelled).toBe(true)
    expect(api.aborts).toEqual([{ key: "sixb/uploads/put-4/object", uploadId: "upload-1" }])
  })

  test("propagates aborts, cancels the source, and cleans multipart state", async () => {
    const api = new RecordingUploadApi()
    const abort = new AbortController()
    let sourceCancelled = false
    api.uploadPart = (input: UploadPartInput) =>
      new Promise<string>((_resolve, reject) => {
        const onAbort = () => reject(input.signal?.reason)
        input.signal?.addEventListener("abort", onAbort, { once: true })
      })

    const upload = uploadBlobStreamToS3({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("abcde"))
        },
        cancel() {
          sourceCancelled = true
        },
      }),
      api,
      key: "sixb/uploads/put-5/object",
      partSizeBytes: 4,
      concurrency: 1,
      retries: 3,
      signal: abort.signal,
    })

    await Bun.sleep(0)
    abort.abort(new Error("cancel upload"))

    await expect(upload).rejects.toThrow("cancel upload")
    expect(sourceCancelled).toBe(true)
    expect(api.aborts).toEqual([{ key: "sixb/uploads/put-5/object", uploadId: "upload-1" }])
  })

  test("rejects size mismatches before creating a staged object", async () => {
    const api = new RecordingUploadApi()

    await expect(
      uploadBlobStreamToS3({
        stream: streamFrom([encoder.encode("abc")]),
        api,
        key: "sixb/uploads/put-6/object",
        partSizeBytes: 4,
        concurrency: 1,
        retries: 0,
        expectedSizeBytes: 4,
      })
    ).rejects.toThrow("expected 4 bytes, received 3")
    expect(api.puts).toHaveLength(0)
    expect(api.creates).toHaveLength(0)
  })
})

describe("isRetryableS3UploadError", () => {
  test("retries transient transport and service errors only", () => {
    expect(isRetryableS3UploadError(new TypeError("fetch failed"))).toBe(true)
    expect(isRetryableS3UploadError({ $metadata: { httpStatusCode: 503 } })).toBe(true)
    expect(isRetryableS3UploadError({ code: "ECONNRESET" })).toBe(true)
    expect(isRetryableS3UploadError({ $metadata: { httpStatusCode: 403 } })).toBe(false)
    expect(isRetryableS3UploadError({ name: "BadDigest", statusCode: 400 })).toBe(false)
  })
})

function streamFrom(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index]
        index += 1
        if (chunk) controller.enqueue(chunk)
        if (index >= chunks.length) controller.close()
      },
    },
    { highWaterMark: 0 }
  )
}
