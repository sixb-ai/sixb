import { afterEach, describe, expect, test } from "bun:test"
import { PlaudApiError, plaud } from "../src"
import {
  block,
  contentHost,
  context,
  details,
  json,
  memoryStore,
  mockFetch,
  recording,
} from "./helpers"

const originalFetch = globalThis.fetch
const client = () => plaud({ tokenStore: memoryStore(), maxRetries: 0 }).connect(context)
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Plaud data access", () => {
  test("matches the official wire protocol and preserves unknown metadata", async () => {
    mockFetch((url, init) => {
      expect(url.origin).toBe("https://platform.plaud.ai")
      expect(url.pathname).toBe("/developer/api/open/third-party/files/")
      expect(url.searchParams.get("page_size")).toBe("10")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer access")
      expect(init.redirect).toBe("error")
      return json({
        type: "list",
        data: [{ ...recording(), future: true }],
        page: 2,
        page_size: 10,
      })
    })
    const result = await (await client()).recordings.list({ page: 2, pageSize: 10 })
    expect(result.data[0]?.future).toBe(true)
  })
  test("iterates beyond the MCP 500-record filter budget", async () => {
    const pages: number[] = []
    mockFetch((url) => {
      const page = Number(url.searchParams.get("page"))
      pages.push(page)
      return json({
        page,
        page_size: 100,
        data: page <= 6 ? Array.from({ length: 100 }, (_, i) => recording(`${page}-${i}`)) : [],
      })
    })
    const found = []
    for await (const file of (await client()).recordings.iterate({
      query: "WEEKLY",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-01",
    }))
      found.push(file)
    expect(found).toHaveLength(600)
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
  test("uses the server page size if it caps the requested size", async () => {
    mockFetch((url) => {
      const page = Number(url.searchParams.get("page"))
      return json({
        page,
        page_size: 10,
        data: page === 1 ? Array.from({ length: 10 }, (_, i) => recording(String(i))) : [],
      })
    })
    const found = []
    for await (const file of (await client()).recordings.iterate()) found.push(file)
    expect(found).toHaveLength(10)
  })
  test("fails on repeated pages instead of hanging or claiming a complete export", async () => {
    mockFetch((url) =>
      json({
        page: Number(url.searchParams.get("page")),
        page_size: 10,
        data: Array.from({ length: 10 }, (_, i) => recording(String(i))),
      })
    )
    const consume = async () => {
      for await (const _file of (await client()).recordings.iterate()) {
        /* consume */
      }
    }
    await expect(consume()).rejects.toThrow("Pagination repeated")
  })
  test("rejects invalid pagination, dates and date ordering before sending a request", async () => {
    let requests = 0
    mockFetch(() => {
      requests++
      return json({})
    })
    const c = await client()
    await expect(c.recordings.list({ pageSize: 9 })).rejects.toThrow("pageSize")
    await expect(c.recordings.list({ page: NaN })).rejects.toThrow("page")
    for (const options of [
      { dateFrom: "2026-02-30" },
      { dateFrom: "2026-10-02", dateTo: "2026-10-01" },
    ]) {
      await expect(c.recordings.iterate(options)[Symbol.asyncIterator]().next()).rejects.toThrow(
        "[SixbPlaud]"
      )
    }
    expect(requests).toBe(0)
  })
  test("loads the entire linked transcript and every note without leaking API credentials", async () => {
    const segments = Array.from({ length: 141 }, (_, i) => ({
      start_time: i,
      end_time: i + 1,
      content: "Example",
      speaker: "Speaker 1",
      original_speaker: "speaker_0",
    }))
    let downloads = 0
    mockFetch((url, init) => {
      if (url.host === contentHost) {
        downloads++
        expect(new Headers(init.headers).has("authorization")).toBe(false)
        expect(new Headers(init.headers).has("x-pld-region")).toBe(false)
        expect(init.redirect).toBe("error")
        expect(init.credentials).toBe("omit")
        return url.pathname === "/transaction" ? json(segments) : new Response("# Custom summary")
      }
      return json(
        details({
          source_list: [block()],
          note_list: [block("custom_template"), block("highlight", "Already inline")],
        })
      )
    })
    const c = await client()
    const transcript = await c.transcripts.get("r1")
    expect(transcript?.segments).toHaveLength(141)
    const exported = await c.recordings.export("r1")
    expect(exported.source_list[0]?.data_content).toBe(JSON.stringify(segments))
    expect(exported.note_list.map((n) => n.data_content)).toEqual([
      "# Custom summary",
      "Already inline",
    ])
    expect(downloads).toBe(3)
  })
  test("preserves unknown blocks and non-JSON content", async () => {
    mockFetch(() => json(details({ source_list: [block("future_block", "plain text")] })))
    const c = await client()
    expect(await c.transcripts.get("r1")).toBeNull()
    expect(await c.transcripts.get("r1", { block: "future_block" })).toMatchObject({
      content: "plain text",
      segments: null,
    })
  })
  test("a linked-content error fails the export instead of returning missing text", async () => {
    mockFetch((url) =>
      url.host === contentHost
        ? json({ secret: "do not log" }, 403)
        : json(details({ source_list: [block()] }))
    )
    await expect((await client()).recordings.export("r1")).rejects.toBeInstanceOf(PlaudApiError)
  })
  test("rejects untrusted URLs and enforces a streamed content limit", async () => {
    for (const link of [
      "http://localhost:80/data",
      "https://127.0.0.1/data",
      "https://evil.example/data",
      `https://user:pass@${contentHost}/data`,
    ]) {
      let calls = 0
      mockFetch(() => {
        calls++
        return json(details({ source_list: [{ ...block(), data_link: link }] }))
      })
      await expect((await client()).transcripts.get("r1")).rejects.toThrow("Untrusted")
      expect(calls).toBe(1)
    }
    mockFetch((url) =>
      url.host === contentHost ? new Response("123456") : json(details({ source_list: [block()] }))
    )
    const c = await plaud({ tokenStore: memoryStore(), maxContentBytes: 5 }).connect(context)
    await expect(c.transcripts.get("r1")).rejects.toThrow("maxContentBytes")
  })
  test("downloads audio as a stream, with a fresh signed URL and no bearer", async () => {
    mockFetch((url, init) => {
      if (url.host === contentHost) {
        expect(new Headers(init.headers).has("authorization")).toBe(false)
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        })
      }
      return json(details())
    })
    const response = await (await client()).recordings.downloadAudio("r1")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
  test("unavailable audio is explicit", async () => {
    mockFetch(() => json(details({ presigned_url: null })))
    await expect((await client()).recordings.downloadAudio("r1")).rejects.toThrow("not available")
  })
  test("IDs stay in one encoded path segment", async () => {
    mockFetch((url) => {
      expect(url.pathname).toBe(
        "/developer/api/open/third-party/files/id%2Fwith%3Fquery%23fragment"
      )
      expect(url.search).toBe("")
      return json(details())
    })
    await (await client()).recordings.get("id/with?query#fragment")
  })
  test("rejects malformed successful responses and reports HTTP errors without body data", async () => {
    mockFetch(() => json({ data: "wrong" }))
    await expect((await client()).recordings.list()).rejects.toThrow("Invalid recordings")
    mockFetch(() => json({ secret: "private body" }, 403))
    try {
      await (await client()).recordings.get("r1")
      throw new Error("expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(PlaudApiError)
      expect(String(error)).not.toContain("private body")
    }
  })
  test("cancels before requests", async () => {
    let requests = 0
    mockFetch(() => {
      requests++
      return json(details())
    })
    await expect(
      (await client()).recordings.get("r1", { signal: AbortSignal.abort() })
    ).rejects.toThrow()
    expect(requests).toBe(0)
  })
})

test("rejects dot-segment IDs before URL normalization", async () => {
  let calls = 0
  mockFetch(() => {
    calls++
    return json(details())
  })
  const c = await client()
  await expect(c.recordings.get("..")).rejects.toThrow("Invalid recording id")
  await expect(c.recordings.get(".")).rejects.toThrow("Invalid recording id")
  expect(calls).toBe(0)
})

test("parses transcript segments with nullable speaker fields", async () => {
  // Live Plaud recordings can have no speaker attribution. Rejecting null in isSegment
  // (resources/transcripts.ts) reproduces this regression: valid segments become null.
  const segments = [
    {
      start_time: 0,
      end_time: 1000,
      content: "Example without speaker attribution",
      speaker: null,
      original_speaker: null,
      embeddingKey: null,
    },
  ]
  mockFetch(() => json(details({ source_list: [block("transaction", JSON.stringify(segments))] })))
  expect((await (await client()).transcripts.get("r1"))?.segments).toEqual(segments)
})
