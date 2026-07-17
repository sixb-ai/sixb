import { expect, test } from "bun:test"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { writeBlobStreamToS3 } from "../src/s3-stream-upload"

const encoder = new TextEncoder()

test("waits for S3 writer backpressure before reading the next chunk", async () => {
  const firstWrite = Promise.withResolvers<number>()
  const chunks = [encoder.encode("first"), encoder.encode("second")]
  let reads = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[reads]
        reads += 1
        if (chunk) {
          controller.enqueue(chunk)
        }
        if (reads === chunks.length) {
          controller.close()
        }
      },
    },
    { highWaterMark: 0 }
  )
  const written: Uint8Array[] = []
  const endedWith: Array<Error | undefined> = []

  const upload = writeBlobStreamToS3({
    stream: body,
    writer: {
      write(chunk) {
        written.push(new Uint8Array(chunk))
        return written.length === 1 ? firstWrite.promise : chunk.byteLength
      },
      end(error) {
        endedWith.push(error)
        return 0
      },
    },
  })

  await Bun.sleep(0)
  expect(reads).toBe(1)
  expect(written).toHaveLength(1)

  firstWrite.resolve(written[0]?.byteLength ?? 0)
  const result = await upload
  const bytes = encoder.encode("firstsecond")

  expect(reads).toBe(2)
  expect(written).toEqual(chunks)
  expect(endedWith).toEqual([undefined])
  expect(result).toEqual({
    digest: computeBlobDigest(bytes),
    sizeBytes: bytes.byteLength,
  })
})

test("aborts the S3 writer and cancels the source stream", async () => {
  const abort = new AbortController()
  const blockedWrite = Promise.withResolvers<number>()
  let bodyCancelled = false
  let writerError: Error | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("partial"))
    },
    cancel() {
      bodyCancelled = true
    },
  })

  const upload = writeBlobStreamToS3({
    stream: body,
    signal: abort.signal,
    writer: {
      write() {
        return blockedWrite.promise
      },
      end(error) {
        writerError = error
        return 0
      },
    },
  })

  await Bun.sleep(0)
  abort.abort(new Error("cancel test upload"))

  await expect(upload).rejects.toThrow("cancel test upload")
  expect(bodyCancelled).toBe(true)
  expect(writerError?.message).toBe("cancel test upload")
})
