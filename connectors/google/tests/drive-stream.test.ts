import { afterEach, describe, expect, test } from "bun:test"
import { GoogleApiError, google } from "../src/index"
import { CONTEXT, json, mockFetch, restoreFetch } from "./helpers"

const nativeFetch = globalThis.fetch

const connect = () => google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
afterEach(restoreFetch)

describe("drive.files.downloadStream", () => {
  // Regression check: buffer mediaResponse with arrayBuffer() before returning it.
  // This test must fail: headers and the first bytes are needed before EOF.
  test("returns an unread response before EOF and consumes only on demand", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array([pulls]))
          if (pulls === 2) controller.close()
        },
      },
      { highWaterMark: 0 }
    )
    mockFetch(async () => new Response(body, { headers: { "content-type": "video/mp4" } }))
    const client = await connect()
    const response = await client.drive.files.downloadStream("video")
    expect(response.bodyUsed).toBe(false)
    expect(pulls).toBe(0)
    expect(response.headers.get("content-type")).toBe("video/mp4")
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    expect(pulls).toBe(1)
    expect((await reader.read()).value).toEqual(new Uint8Array([2]))
    expect((await reader.read()).done).toBe(true)
  })

  test("encodes the ID and sends Drive options, auth, range, and request signal", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    mockFetch(async (input, init) => {
      expect(String(input)).toBe(
        "https://www.googleapis.com/drive/v3/files/a%2Fb?alt=media&supportsAllDrives=true&acknowledgeAbuse=true"
      )
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer test-token")
      expect(headers.get("range")).toBe("bytes=500-999")
      receivedSignal = init?.signal
      return new Response(new Uint8Array(500), {
        status: 206,
        headers: { "content-range": "bytes 500-999/2000", "content-length": "500" },
      })
    })
    const client = await connect()
    const response = await client.drive.files.downloadStream("a/b", {
      supportsAllDrives: true,
      acknowledgeAbuse: true,
      range: { start: 500, endInclusive: 999 },
      signal: controller.signal,
    })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 500-999/2000")
    expect(response.headers.get("content-length")).toBe("500")
    controller.abort()
    expect(receivedSignal?.aborted).toBe(true)
    await response.body?.cancel()
  })

  test("allows open-ended ranges and preserves 200 when the server ignores Range", async () => {
    mockFetch(async (_input, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=5-")
      return new Response("full file")
    })
    const response = await (await connect()).drive.files.downloadStream("video", {
      range: { start: 5 },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("full file")
  })

  test("rejects invalid offsets and empty IDs before fetching", async () => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      return new Response()
    })
    const { files } = (await connect()).drive
    for (const range of [
      { start: -1 },
      { start: 0.5 },
      { start: Number.NaN },
      { start: Infinity },
      { start: Number.MAX_SAFE_INTEGER + 1 },
      { start: 3, endInclusive: 2 },
      { start: 0, endInclusive: -1 },
      { start: 0, endInclusive: 0.5 },
      { start: 0, endInclusive: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => files.downloadStream("video", { range })).toThrow("[SixbGoogle] Download range")
    }
    expect(() => files.downloadStream(" ")).toThrow("fileId")
    expect(calls).toBe(0)
  })

  test("cancelling the response releases the source", async () => {
    let reason: unknown
    mockFetch(
      async () =>
        new Response(
          new ReadableStream({
            cancel(value) {
              reason = value
            },
          })
        )
    )
    const response = await (await connect()).drive.files.downloadStream("video")
    await response.body!.cancel("consumer stopped")
    expect(reason).toBe("consumer stopped")
  })

  test("propagates body failures without replaying delivered bytes", async () => {
    let calls = 0
    const failure = new Error("connection lost")
    mockFetch(async () => {
      calls += 1
      let first = true
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (first) {
                first = false
                controller.enqueue(new Uint8Array([1]))
              } else controller.error(failure)
            },
          },
          { highWaterMark: 0 }
        )
      )
    })
    const response = await (await connect()).drive.files.downloadStream("video")
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    await expect(reader.read()).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  test.each([403, 416])("maps HTTP %s to GoogleApiError before exposing a body", async (status) => {
    mockFetch(async () =>
      json({ error: { code: status, message: "download rejected" } }, { status })
    )
    const client = await connect()
    try {
      await client.drive.files.downloadStream("video")
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleApiError)
      expect((error as GoogleApiError).status).toBe(status)
      expect((error as Error).message).toContain("download rejected")
    }
  })

  test("retains auth refresh and transient retries before returning the response", async () => {
    let calls = 0
    let tokens = 0
    const signals: (AbortSignal | null | undefined)[] = []
    const abort = new AbortController()
    mockFetch(async (_input, init) => {
      signals.push(init?.signal)
      calls += 1
      if (calls === 1) return new Response("expired", { status: 401 })
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer token-${calls}`)
      if (calls === 2) return new Response("busy", { status: 503 })
      return new Response("video")
    })
    const client = await google({
      auth: { token: () => `token-${++tokens}` },
      retry: { maxRetries: 2, delayMs: () => 0 },
    }).connect(CONTEXT)
    const response = await client.drive.files.downloadStream("video", { signal: abort.signal })
    expect(await response.text()).toBe("video")
    expect(calls).toBe(3)
    abort.abort()
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
  })

  test.each([
    "request",
    "context",
  ] as const)("aborting the %s signal interrupts a real HTTP body after headers", async (source) => {
    const abort = new AbortController()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([42]))
            },
          })
        )
      },
    })
    try {
      mockFetch(async (_input, init) => nativeFetch(server.url, init))
      const client = await google({ auth: { token: () => "test" } }).connect({
        ...CONTEXT,
        signal: source === "context" ? abort.signal : CONTEXT.signal,
      })
      const response = await client.drive.files.downloadStream("video", {
        signal: source === "request" ? abort.signal : undefined,
      })
      const reader = response.body!.getReader()
      expect((await reader.read()).value).toEqual(new Uint8Array([42]))
      const next = reader.read()
      abort.abort()
      await expect(next).rejects.toThrow()
    } finally {
      abort.abort()
      await server.stop(true)
    }
  }, 3000)

  test("an already aborted request never fetches", async () => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      return new Response()
    })
    const client = await connect()
    await expect(
      client.drive.files.downloadStream("video", {
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow()
    expect(calls).toBe(0)
  })
})
