import { describe, expect, test } from "bun:test"
import { buildMultipartBody, chunkBody, persistedOffset, uploadSize } from "../src/upload"

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }
  return chunks
}

function bytes(range: readonly number[]): Uint8Array {
  return new Uint8Array(range)
}

describe("uploadSize", () => {
  test("buffered bodies use their real length, ignoring the sizeBytes hint", () => {
    expect(uploadSize(new Uint8Array(10), undefined)).toBe(10)
    expect(uploadSize(new Uint8Array(10), 10_000_000)).toBe(10)
    expect(uploadSize(new ArrayBuffer(4), 99)).toBe(4)
    expect(uploadSize(new Blob([new Uint8Array(7)]), 42)).toBe(7)
  })

  test("streams use the hint, or undefined without one", () => {
    expect(uploadSize(streamOf([]), 123)).toBe(123)
    expect(uploadSize(streamOf([]), undefined)).toBeUndefined()
  })
})

describe("chunkBody", () => {
  test("slices buffers without copying byte content", async () => {
    const body = new Uint8Array(10).map((_, i) => i)
    const chunks = await collect(chunkBody(body, 4))

    expect(chunks.map((c) => Array.from(c))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
  })

  test("slices Blobs lazily into chunk-sized reads", async () => {
    const body = new Blob([new Uint8Array(9).map((_, i) => i)])
    const chunks = await collect(chunkBody(body, 4))

    expect(chunks.map((c) => c.length)).toEqual([4, 4, 1])
    expect(chunks.flatMap((c) => Array.from(c))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("stream of exactly one chunk", async () => {
    const chunks = await collect(chunkBody(streamOf([bytes([1, 2, 3, 4])]), 4))
    expect(chunks.map((c) => Array.from(c))).toEqual([[1, 2, 3, 4]])
  })

  test("stream one byte over the chunk size", async () => {
    const chunks = await collect(chunkBody(streamOf([bytes([1, 2, 3, 4, 5])]), 4))
    expect(chunks.map((c) => Array.from(c))).toEqual([[1, 2, 3, 4], [5]])
  })

  test("many tiny reads merge and split in order, no lost or duplicated bytes", async () => {
    const reads = Array.from({ length: 11 }, (_, i) => bytes([i]))
    const chunks = await collect(chunkBody(streamOf(reads), 4))

    expect(chunks.map((c) => c.length)).toEqual([4, 4, 3])
    expect(chunks.flatMap((c) => Array.from(c))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test("a single huge read splits into full chunks plus tail", async () => {
    const big = new Uint8Array(11).map((_, i) => i)
    const chunks = await collect(chunkBody(streamOf([big]), 4))

    expect(chunks.map((c) => c.length)).toEqual([4, 4, 3])
    expect(chunks.flatMap((c) => Array.from(c))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test("exact multiples never emit a trailing empty chunk", async () => {
    const chunks = await collect(chunkBody(streamOf([new Uint8Array(8)]), 4))
    expect(chunks.map((c) => c.length)).toEqual([4, 4])
  })

  test("an empty stream yields nothing", async () => {
    expect(await collect(chunkBody(streamOf([]), 4))).toEqual([])
  })
})

describe("buildMultipartBody", () => {
  test("metadata part precedes the media part with CRLF framing", () => {
    const body = buildMultipartBody({ name: "a.txt" }, "text/plain", bytes([104, 105]), "b")
    const text = new TextDecoder().decode(body)

    expect(text).toBe(
      '--b\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.txt"}\r\n' +
        "--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b--\r\n"
    )
  })

  test("undefined metadata serializes as an empty object", () => {
    const text = new TextDecoder().decode(
      buildMultipartBody(undefined, "text/csv", bytes([120]), "b")
    )
    expect(text).toContain("\r\n\r\n{}\r\n")
  })
})

describe("persistedOffset", () => {
  test("parses Google's Range header into a next-byte offset", () => {
    expect(persistedOffset("bytes=0-0")).toBe(1)
    expect(persistedOffset("bytes=0-8388607")).toBe(8388608)
  })

  test("returns null for missing or malformed headers", () => {
    expect(persistedOffset(null)).toBeNull()
    expect(persistedOffset("")).toBeNull()
    expect(persistedOffset("bytes=10-20")).toBeNull()
    expect(persistedOffset("bytes=0-")).toBeNull()
    expect(persistedOffset("garbage")).toBeNull()
  })
})
