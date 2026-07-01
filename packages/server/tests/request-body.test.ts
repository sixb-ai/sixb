import { describe, expect, test } from "bun:test"
import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "../src/utils/request-body"

function streamRequest(chunks: readonly Uint8Array[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
  // A ReadableStream body carries no content-length, so this exercises the
  // streaming cap rather than the content-length fast path.
  return new Request("http://localhost/upload", {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
}

describe("readRequestBodyWithLimit", () => {
  test("reads the full body when within the limit", async () => {
    const bytes = await readRequestBodyWithLimit(streamRequest([new Uint8Array([1, 2, 3])]), 10)
    expect([...bytes]).toEqual([1, 2, 3])
  })

  test("concatenates multiple chunks in order", async () => {
    const bytes = await readRequestBodyWithLimit(
      streamRequest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      10
    )
    expect([...bytes]).toEqual([1, 2, 3, 4])
  })

  test("rejects a streamed body that exceeds the limit", async () => {
    const chunk = new Uint8Array(6)
    await expect(
      readRequestBodyWithLimit(streamRequest([chunk, chunk]), 10)
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  test("rejects oversized bodies via the content-length fast path", async () => {
    const request = new Request("http://localhost/upload", {
      method: "PUT",
      headers: { "content-length": "100" },
      body: "tiny",
    })
    await expect(readRequestBodyWithLimit(request, 10)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    )
  })

  test("surfaces the provided too-large message", async () => {
    const request = new Request("http://localhost/upload", {
      method: "PUT",
      headers: { "content-length": "100" },
      body: "tiny",
    })
    await expect(readRequestBodyWithLimit(request, 10, "custom limit message")).rejects.toThrow(
      "custom limit message"
    )
  })

  test("returns an empty array for a bodyless request", async () => {
    const bytes = await readRequestBodyWithLimit(
      new Request("http://localhost/upload", { method: "GET" }),
      10
    )
    expect(bytes.byteLength).toBe(0)
  })
})
