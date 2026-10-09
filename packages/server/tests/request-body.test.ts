import { describe, expect, test } from "bun:test"
import {
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  limitRequestBody,
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
} from "../src/utils/request-body"

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

describe("limitRequestBody", () => {
  test("rejects a streamed body at the default limit, before reading the rest", async () => {
    const chunk = new Uint8Array(64 * 1024)
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength
        if (pulled > 16 * DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    })
    const request = limitRequestBody(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    )

    await expect(request.arrayBuffer()).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(pulled).toBeLessThan(2 * DEFAULT_REQUEST_BODY_LIMIT_BYTES)
  })

  test("passes a body within the default limit through unchanged", async () => {
    const request = limitRequestBody(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      })
    )

    expect(await request.json()).toEqual({ ok: true })
  })

  test("lets the route's own limit replace the default", async () => {
    const request = limitRequestBody(
      streamRequest([new Uint8Array(DEFAULT_REQUEST_BODY_LIMIT_BYTES), new Uint8Array(1)])
    )

    const bytes = await readRequestBodyWithLimit(request, 2 * DEFAULT_REQUEST_BODY_LIMIT_BYTES)
    expect(bytes.byteLength).toBe(DEFAULT_REQUEST_BODY_LIMIT_BYTES + 1)
  })
})
