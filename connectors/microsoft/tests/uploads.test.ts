import { afterEach, describe, expect, test } from "bun:test"
import {
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
  MicrosoftUploadError,
  type UploadSession,
} from "../src"
import { apiError, CONTEXT, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const Q = 320 * 1024
const SESSION: UploadSession = {
  uploadUrl: "https://uploads.1drv.com/session?signature=secret",
  expirationDateTime: "2099-01-01T00:00:00Z",
}
const state = (ranges: string[], status = 200) =>
  json({ expirationDateTime: SESSION.expirationDateTime, nextExpectedRanges: ranges }, status)

describe("file uploads", () => {
  test("small and empty files use binary PUT, encode names, and default to fail on creation conflicts", async () => {
    const requests = mockFetch(() => json({ id: "file" }, 201))
    const client = await connect()
    await client.drives.uploads.upload(
      "d",
      { parentId: "root", name: "é #%.txt" },
      Uint8Array.from([0, 255])
    )
    await client.drives.uploads.upload("d", { itemId: "file" }, new Uint8Array())
    expect(requests[0].url).toStartWith(`${GRAPH}drives/d/root:/%C3%A9%20%23%25.txt:/content?`)
    expect(new URL(requests[0].url).searchParams.get("@microsoft.graph.conflictBehavior")).toBe(
      "fail"
    )
    expect(
      Array.from(new Uint8Array(await new Response(requests[0].init.body).arrayBuffer()))
    ).toEqual([0, 255])
    expect(requests[0].headers.get("content-type")).toBe("application/octet-stream")
    expect(new URL(requests[1].url).searchParams.get("@microsoft.graph.conflictBehavior")).toBe(
      "replace"
    )
    expect(await new Response(requests[1].init.body).text()).toBe("")
  })

  test("large uploads create a session and stream sequential aligned fragments without bearer headers", async () => {
    const size = 10 * 1024 * 1024 + 7
    const ranges: string[] = []
    const requests = mockFetch(async (r) => {
      if (r.method === "POST") return json(SESSION)
      expect(r.headers.has("authorization")).toBe(false)
      expect(r.url).toBe(SESSION.uploadUrl)
      ranges.push(r.headers.get("content-range") ?? "")
      const length = (await new Response(r.init.body).arrayBuffer()).byteLength
      expect(r.headers.get("content-length")).toBe(String(length))
      return ranges.length === 1
        ? state([`${10 * 1024 * 1024}-`], 202)
        : json({ id: "uploaded", size }, 201)
    })
    const client = await connect()
    const result = await client.drives.uploads.upload(
      "d",
      { parentId: "p", name: "large.bin" },
      new Blob([new Uint8Array(size)])
    )
    expect(result.id).toBe("uploaded")
    expect(ranges).toEqual([`bytes 0-10485759/${size}`, `bytes 10485760-10485766/${size}`])
    expect(requests[0].headers.get("authorization")).toBe("Bearer graph-token")
    expect(requests[0].url).toBe(`${GRAPH}drives/d/items/p:/large.bin:/createUploadSession`)
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      item: { name: "large.bin", "@microsoft.graph.conflictBehavior": "fail" },
    })
  })

  test("conditional replacements pass If-Match to session creation", async () => {
    const requests = mockFetch((r) => (r.method === "POST" ? json(SESSION) : json({ id: "file" })))
    const client = await connect()
    await client.drives.uploads.upload("d", { itemId: "file" }, new Blob(["data"]), {
      ifMatch: '"etag"',
    })
    expect(requests[0].url).toBe(`${GRAPH}drives/d/items/file/createUploadSession`)
    expect(requests[0].headers.get("if-match")).toBe('"etag"')
    expect(requests[1].headers.has("if-match")).toBe(false)
  })

  test("resume starts at the server's persisted range and preserves slice bytes", async () => {
    const bytes = new Uint8Array(Q + 3)
    bytes.set([1, 2, 3], Q)
    const requests = mockFetch(async (r) => {
      if (r.method === "GET") return state([`${Q}-`])
      expect(Array.from(new Uint8Array(await new Response(r.init.body).arrayBuffer()))).toEqual([
        1, 2, 3,
      ])
      expect(r.headers.get("content-range")).toBe(`bytes ${Q}-${Q + 2}/${Q + 3}`)
      return json({ id: "file" })
    })
    const client = await connect()
    expect((await client.drives.uploads.resume(SESSION, bytes, { chunkSize: Q })).id).toBe("file")
    expect(requests).toHaveLength(2)
  })

  test("416 reconciles the session before resending, rather than trusting a local offset", async () => {
    let reads = 0
    let puts = 0
    const requests = mockFetch((r) => {
      if (r.method === "GET") return state([`${reads++ === 0 ? 0 : Q}-`])
      puts++
      if (puts === 1) return apiError(416, "invalidRange")
      expect(r.headers.get("content-range")).toBe(`bytes ${Q}-${Q + 2}/${Q + 3}`)
      return json({ id: "file" })
    })
    const client = await connect()
    await client.drives.uploads.resume(SESSION, new Uint8Array(Q + 3), { chunkSize: Q })
    expect(requests.map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"])
  })

  // Countercheck: cap fragment end at range.end instead of content.size in transfer; this fails.
  test("missing range boundaries do not determine upload fragment sizes", async () => {
    const bytes = new Uint8Array(2 * Q + 3)
    bytes.fill(17)
    const ranges: string[] = []
    mockFetch(async (r) => {
      if (r.method === "GET") return state([`0-${Q - 2}`, `${Q + 1}-`])
      ranges.push(r.headers.get("content-range") ?? "")
      const body = new Uint8Array(await new Response(r.init.body).arrayBuffer())
      expect(body.every((byte) => byte === 17)).toBe(true)
      if (ranges.length === 1) return state([`${Q}-${Q + 4}`], 202)
      if (ranges.length === 2) return state([`${2 * Q}-`], 202)
      return json({ id: "file" }, 201)
    })
    const client = await connect()
    expect((await client.drives.uploads.resume(SESSION, bytes, { chunkSize: Q })).id).toBe("file")
    expect(ranges).toEqual([
      `bytes 0-${Q - 1}/${bytes.length}`,
      `bytes ${Q}-${2 * Q - 1}/${bytes.length}`,
      `bytes ${2 * Q}-${2 * Q + 2}/${bytes.length}`,
    ])
  })

  // Countercheck: retain the original session in the transfer error; this loses the new expiry.
  test("interrupted transfers retain the latest acknowledged session expiry and ranges", async () => {
    const expirationDateTime = "2099-01-02T00:00:00Z"
    let puts = 0
    mockFetch((r) => {
      if (r.method === "GET") return state(["0-"])
      if (++puts === 1) return json({ expirationDateTime, nextExpectedRanges: [`${Q}-`] }, 202)
      return apiError(400, "invalidRequest")
    })
    const client = await connect()
    await expect(
      client.drives.uploads.resume(SESSION, new Uint8Array(Q + 1), { chunkSize: Q })
    ).rejects.toMatchObject({
      name: "MicrosoftUploadError",
      session: { ...SESSION, expirationDateTime, nextExpectedRanges: [`${Q}-`] },
    })
    expect(SESSION.expirationDateTime).toBe("2099-01-01T00:00:00Z")
  })

  test("429 and 503 query status before bounded retry and honor Retry-After", async () => {
    for (const code of [429, 503]) {
      let puts = 0
      const requests = mockFetch((r) =>
        r.method === "GET"
          ? state(["0-"])
          : ++puts === 1
            ? apiError(code, "transient", { "retry-after": "0" })
            : json({ id: "file" })
      )
      const client = await connect()
      expect((await client.drives.uploads.resume(SESSION, new Blob(["content"]))).id).toBe("file")
      expect(requests.map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"])
    }
  })

  // Countercheck: accept nextExpectedRanges without checking progress in transfer; this must fail.
  test("non-advancing acknowledgements fail and retain a resumable session", async () => {
    let calls = 0
    // Bound the mock too, so removing the guard produces an assertion failure, not a spin loop.
    const requests = mockFetch((r) =>
      ++calls <= 2 ? state(["0-"], r.method === "GET" ? 200 : 202) : apiError(400)
    )
    const client = await connect()
    const error = await client.drives.uploads
      .resume(SESSION, new Uint8Array(Q + 1), { chunkSize: Q })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MicrosoftUploadError)
    expect(error).toMatchObject({
      session: SESSION,
      completionUnknown: false,
      cause: {
        message: "[SixbMicrosoft] Upload acknowledgement did not advance to the next fragment.",
      },
    })
    expect(requests).toHaveLength(2)
    expect(String(error)).not.toContain("signature=secret")
  })

  test("a lost final response with a vanished session never starts a second upload", async () => {
    let reads = 0
    const requests = mockFetch((r) => {
      if (r.method === "GET") return reads++ === 0 ? state(["0-"]) : apiError(404, "itemNotFound")
      return apiError(503, "lostCommitResponse", { "retry-after": "0" })
    })
    const client = await connect()
    await expect(
      client.drives.uploads.resume(SESSION, new Blob(["content"]))
    ).rejects.toMatchObject({
      name: "MicrosoftUploadError",
      completionUnknown: true,
      cause: { status: 404 },
    })
    expect(requests.map((r) => r.method)).toEqual(["GET", "PUT", "GET"])
  })

  test("persistent failures are bounded and keep the server session available", async () => {
    const requests = mockFetch((r) =>
      r.method === "GET" ? state(["0-"]) : apiError(503, "unavailable", { "retry-after": "0" })
    )
    const client = await connect()
    await expect(
      client.drives.uploads.resume(SESSION, new Blob(["content"]))
    ).rejects.toMatchObject({ name: "MicrosoftUploadError", session: SESSION })
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(3)
  })

  test("invalid ranges, premature completion and malformed sessions cannot report success", async () => {
    const client = await connect()
    for (const ranges of [["bad"], ["99-"], ["0-9999999"], ["2-1"], []]) {
      mockFetch(() => state(ranges))
      await expect(client.drives.uploads.resume(SESSION, new Blob(["abc"]))).rejects.toBeInstanceOf(
        Error
      )
    }
    mockFetch((r) => (r.method === "GET" ? state(["0-"]) : json({ id: "too-early" }, 201)))
    await expect(
      client.drives.uploads.resume(SESSION, new Uint8Array(Q + 1), { chunkSize: Q })
    ).rejects.toMatchObject({
      name: "MicrosoftUploadError",
      cause: { name: "MicrosoftProtocolError" },
    })
    mockFetch(() => json({ uploadUrl: "https://uploads.1drv.com/session" }))
    await expect(client.drives.uploads.createSession("d", { itemId: "f" })).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
  })

  test("validates fragment sizes and targets before creating any remote session", async () => {
    const requests = mockFetch(() => json(SESSION))
    const client = await connect()
    for (const chunkSize of [0, 1, -Q, 60 * 1024 * 1024, Number.NaN]) {
      await expect(
        client.drives.uploads.upload("d", { itemId: "f" }, new Blob(["data"]), { chunkSize })
      ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    }
    await expect(
      client.drives.uploads.upload("d", { parentId: "root", name: "../bad" }, new Blob(["x"]))
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    expect(requests).toHaveLength(0)
  })

  test("session cancellation omits credentials and does not replay a delete", async () => {
    const requests = mockFetch(() => new Response(null, { status: 204 }))
    const client = await connect()
    await client.drives.uploads.cancel(SESSION)
    expect(requests[0].method).toBe("DELETE")
    expect(requests[0].headers.has("authorization")).toBe(false)
    expect(requests[0].url).toBe(SESSION.uploadUrl)
  })

  test("connection cancellation interrupts Retry-After waiting without waiting for its deadline", async () => {
    const controller = new AbortController()
    mockFetch((r) => {
      if (r.method === "GET") return state(["0-"])
      controller.abort()
      return apiError(429, "throttled", { "retry-after": "3600" })
    })
    const client = await connect({}, { ...CONTEXT, signal: controller.signal })
    await expect(
      client.drives.uploads.resume(SESSION, new Blob(["content"]))
    ).rejects.toMatchObject({ name: "MicrosoftUploadError", cause: { name: "AbortError" } })
  })
})
