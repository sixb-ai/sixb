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

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const chunks: number[][] = []
  for await (const chunk of iterable) {
    chunks.push(Array.from(chunk))
  }
  return chunks
}

function bytes(range: readonly number[]): Uint8Array {
  return new Uint8Array(range)
}

function sequence(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).map((_, i) => i)
}

test("uploadSize uses a buffered body's real length and a stream's sizeBytes hint", () => {
  expect(uploadSize(new Uint8Array(10), undefined)).toBe(10)
  expect(uploadSize(new Uint8Array(10), 10_000_000)).toBe(10)
  expect(uploadSize(new ArrayBuffer(4), 99)).toBe(4)
  expect(uploadSize(new Blob([new Uint8Array(7)]), 42)).toBe(7)
  expect(uploadSize(streamOf([]), 123)).toBe(123)
  expect(uploadSize(streamOf([]), undefined)).toBeUndefined()
})

describe("chunkBody", () => {
  test("slices buffers without copying byte content", async () => {
    expect(await collect(chunkBody(sequence(10), 4))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
  })

  test("slices Blobs lazily into chunk-sized reads", async () => {
    expect(await collect(chunkBody(new Blob([sequence(9)]), 4))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8],
    ])
  })

  const streams: Array<[string, Uint8Array[], number[][]]> = [
    ["exactly one chunk", [bytes([1, 2, 3, 4])], [[1, 2, 3, 4]]],
    ["one byte over the chunk size", [bytes([1, 2, 3, 4, 5])], [[1, 2, 3, 4], [5]]],
    [
      "many tiny reads, merged in order",
      Array.from({ length: 11 }, (_, i) => bytes([i])),
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10],
      ],
    ],
    [
      "a single huge read",
      [sequence(11)],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10],
      ],
    ],
    [
      "an exact multiple, with no trailing empty chunk",
      [sequence(8)],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ],
    ],
    ["an empty stream", [], []],
  ]

  test.each(streams)("re-chunks a stream of %s", async (_name, reads, expected) => {
    expect(await collect(chunkBody(streamOf(reads), 4))).toEqual(expected)
  })
})

test("buildMultipartBody frames the metadata part before the media part with CRLFs", () => {
  const body = buildMultipartBody({ name: "a.txt" }, "text/plain", bytes([104, 105]), "b")
  expect(new TextDecoder().decode(body)).toBe(
    '--b\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.txt"}\r\n' +
      "--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b--\r\n"
  )

  // Undefined metadata serializes as an empty object.
  const empty = buildMultipartBody(undefined, "text/csv", bytes([120]), "b")
  expect(new TextDecoder().decode(empty)).toContain("\r\n\r\n{}\r\n")
})

test("persistedOffset parses Google's Range header into the next byte offset, else null", () => {
  expect(persistedOffset("bytes=0-0")).toBe(1)
  expect(persistedOffset("bytes=0-8388607")).toBe(8388608)
  for (const header of [null, "", "bytes=10-20", "bytes=0-", "garbage"]) {
    expect(persistedOffset(header)).toBeNull()
  }
})
