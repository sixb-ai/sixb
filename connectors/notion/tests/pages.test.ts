import { afterEach, describe, expect, test } from "bun:test"
import {
  NotionApiError,
  type NotionConnectorOptions,
  type NotionCreatePageParameters,
  type NotionMarkdownResponse,
  type NotionPageResponse,
  type NotionPropertyResponse,
  type NotionUpdateMarkdownParameters,
  notion,
} from "../src"

const PAGE_ID = "b55c9c91-384d-452b-81db-d1ef79372b75"
const PARENT_ID = "3c357473-a281-49a4-88c0-10d2b245a589"
const PAGE: NotionPageResponse = { object: "page", id: PAGE_ID }
const MARKDOWN: NotionMarkdownResponse = {
  object: "page_markdown",
  id: PAGE_ID,
  markdown: "# Hello\nWorld",
  truncated: false,
  unknown_block_ids: [],
}
const originalFetch = globalThis.fetch
const calls: { url: URL; init: RequestInit; body: unknown }[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  calls.length = 0
})

function respond(body: unknown = PAGE, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}

function mockFetch(handler: (init: RequestInit) => Response | Promise<Response> = () => respond()) {
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({
      url: new URL(String(input)),
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return handler(init)
  }) as typeof fetch
}

async function client(
  options: Partial<NotionConnectorOptions> = {},
  signal = new AbortController().signal
) {
  return notion({ token: "test-token", minDelayMs: 0, ...options }).connect({
    connectorId: "notion",
    projectId: "test",
    signal,
  })
}

describe("Notion pages", () => {
  test("connects lazily and resolves the token on every request", async () => {
    mockFetch()
    let token = "first"
    const adapter = notion({ token: async () => token, minDelayMs: 0 })
    const api = await adapter.connect({
      projectId: "test",
      connectorId: "notion",
      signal: new AbortController().signal,
    })
    expect(adapter.type).toBe("notion")
    expect(calls).toHaveLength(0)
    await api.pages.retrieve({ page_id: PAGE_ID, filter_properties: ["title", "a&b"] })
    token = "second"
    await api.pages.retrieve({ page_id: PAGE_ID })
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer first")
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer second")
    expect(new Headers(calls[0]?.init.headers).get("notion-version")).toBe("2026-03-11")
    expect(calls[0]?.url.origin).toBe("https://api.notion.com")
    expect(calls[0]?.url.pathname).toBe(`/v1/pages/${PAGE_ID}`)
    expect(calls[0]?.url.searchParams.getAll("filter_properties")).toEqual(["title", "a&b"])
    expect(calls[0]?.init.redirect).toBe("error")
    expect(calls[0]?.body).toBeUndefined()
  })

  test("creates a page and sends filter_properties only in the query", async () => {
    mockFetch()
    const api = await client({ baseUrl: "http://localhost:8080/proxy/v1" })
    const body = { parent: { page_id: PARENT_ID }, markdown: "# Hello\nWorld" }
    expect(await api.pages.create({ ...body, filter_properties: ["title"] })).toEqual(PAGE)
    expect(calls[0]?.url.pathname).toBe("/proxy/v1/pages")
    expect(calls[0]?.init.method).toBe("POST")
    expect(calls[0]?.body).toEqual(body)
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json")
  })

  test("updates properties, clears nullable fields, moves, trashes and restores", async () => {
    mockFetch()
    const api = await client()
    const properties = { Name: { title: [{ text: { content: "Changed" } }] } }
    await api.pages.update({
      page_id: PAGE_ID,
      properties,
      icon: null,
      is_locked: false,
      filter_properties: ["Name"],
    })
    expect(calls[0]?.body).toEqual({ properties, icon: null, is_locked: false })
    expect(calls[0]?.url.searchParams.get("filter_properties")).toBe("Name")
    await api.pages.move({ page_id: PAGE_ID, parent: { data_source_id: PARENT_ID } })
    expect(calls[1]?.url.pathname).toBe(`/v1/pages/${PAGE_ID}/move`)
    expect(calls[1]?.init.method).toBe("POST")
    expect(calls[1]?.body).toEqual({ parent: { data_source_id: PARENT_ID } })
    await api.pages.trash({ page_id: PAGE_ID })
    await api.pages.restore({ page_id: PAGE_ID })
    expect(calls.slice(2).map((call) => call.init.method)).toEqual(["PATCH", "PATCH"])
    expect(calls.slice(2).map((call) => call.body)).toEqual([
      { in_trash: true },
      { in_trash: false },
    ])
  })

  test("preserves scalar properties, paginated rollup metadata and opaque cursors", async () => {
    const cursor = "session/%+opaque=&"
    const rollup = { type: "incomplete", incomplete: {}, function: "sum" } as const
    const first: NotionPropertyResponse = {
      object: "list",
      type: "property_item",
      results: [],
      has_more: true,
      next_cursor: cursor,
      property_item: { id: "abc", type: "rollup", rollup, next_url: "https://untrusted.example/" },
    }
    const scalar: NotionPropertyResponse = {
      object: "property_item",
      id: "abc",
      type: "number",
      number: 42,
    }
    mockFetch(() => (calls.length === 1 ? respond(first) : respond(scalar)))
    const api = await client()
    const result = await api.pages.properties.retrieve({
      page_id: PAGE_ID,
      property_id: "M%3BBw",
      page_size: 10,
    })
    expect(result).toEqual(first)
    expect(calls[0]?.url.pathname).toBe(`/v1/pages/${PAGE_ID}/properties/M%3BBw`)
    expect(calls[0]?.url.searchParams.get("page_size")).toBe("10")
    if (result.object !== "list") throw new Error("Expected list")
    const second = await api.pages.properties.retrieve({
      page_id: PAGE_ID,
      property_id: "M;Bw",
      start_cursor: result.next_cursor,
    })
    expect(second).toEqual(scalar)
    expect(calls[1]?.url.origin).toBe("https://api.notion.com")
    expect(calls[1]?.url.searchParams.get("start_cursor")).toBe(cursor)
    expect(calls[1]?.url.pathname).toBe(calls[0]?.url.pathname)
  })

  test("returns Markdown completeness fields and sends update commands without path fields", async () => {
    const partial = { ...MARKDOWN, truncated: true, unknown_block_ids: [PARENT_ID] }
    mockFetch(() => respond(partial))
    const api = await client()
    expect(
      await api.pages.retrieveMarkdown({ page_id: PAGE_ID, include_transcript: false })
    ).toEqual(partial)
    expect(calls[0]?.url.searchParams.get("include_transcript")).toBe("false")
    const updates: NotionUpdateMarkdownParameters[] = [
      {
        page_id: PAGE_ID,
        type: "update_content",
        update_content: {
          content_updates: [{ old_str: "Hello", new_str: "Bonjour", replace_all_matches: true }],
        },
      },
      { page_id: PAGE_ID, type: "replace_content", replace_content: { new_str: "# Replacement" } },
      {
        page_id: PAGE_ID,
        type: "insert_content",
        insert_content: { content: "Appended", position: { type: "end" } },
      },
      {
        page_id: PAGE_ID,
        type: "replace_content_range",
        replace_content_range: {
          content_range: "start...end",
          content: "replacement",
          allow_deleting_content: false,
        },
      },
    ]
    for (const update of updates) {
      expect(await api.pages.updateMarkdown(update)).toEqual(partial)
      const { page_id: _id, ...body } = update
      expect(calls.at(-1)?.body).toEqual(body)
      expect(calls.at(-1)?.url.pathname).toBe(`/v1/pages/${PAGE_ID}/markdown`)
      expect(calls.at(-1)?.init.method).toBe("PATCH")
    }
  })

  test.each([
    401, 403, 404, 400,
  ])("preserves structured API errors without retrying HTTP %i", async (status) => {
    const body = {
      object: "error",
      code: "restricted_resource",
      message: "Access denied",
      request_id: "req-1",
      additional_data: { detail: "retained" },
    }
    mockFetch(() => respond(body, status, { "retry-after": "2" }))
    const api = await client()
    try {
      await api.pages.retrieve({ page_id: PAGE_ID })
      throw new Error("Expected request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(NotionApiError)
      if (!(error instanceof NotionApiError)) throw error
      expect(error.status).toBe(status)
      expect(error.code).toBe("restricted_resource")
      expect(error.requestId).toBe("req-1")
      expect(error.retryAfterMs).toBe(2000)
      expect(error.responseBody).toEqual(body)
      expect(error.message).toContain("[SixbNotion]")
    }
    expect(calls).toHaveLength(1)
  })

  test("preserves non-JSON provider failures", async () => {
    mockFetch(() => new Response("upstream failure", { status: 502 }))
    const api = await client({ maxRetries: 0 })
    await expect(api.pages.retrieve({ page_id: PAGE_ID })).rejects.toMatchObject({
      status: 502,
      responseBody: "upstream failure",
    })
  })

  test.each([
    {},
    { object: "async_task", id: "task" },
    { ...MARKDOWN, truncated: undefined },
  ])("rejects malformed or unexpected successful responses", async (body) => {
    mockFetch(() => respond(body))
    const api = await client()
    await expect(api.pages.retrieveMarkdown({ page_id: PAGE_ID })).rejects.toThrow(
      "Invalid page_markdown response"
    )
    expect(calls).toHaveLength(1)
  })
})

describe("Notion request safety", () => {
  // Guard check: replace the idempotent condition in notion.ts with true; the 503
  // create test below must fail because an ambiguous write would run three times.
  test.each([500, 503])("does not replay a creation after an ambiguous HTTP %i", async (status) => {
    mockFetch(() => respond({ object: "error" }, status, { "retry-after": "0" }))
    const api = await client()
    await expect(
      api.pages.create({ parent: { page_id: PARENT_ID }, markdown: "Hello" })
    ).rejects.toBeInstanceOf(NotionApiError)
    expect(calls).toHaveLength(1)
  })

  test("does not replay a write after a network failure", async () => {
    mockFetch(() => {
      throw new TypeError("connection reset")
    })
    const api = await client()
    await expect(
      api.pages.updateMarkdown({
        page_id: PAGE_ID,
        type: "replace_content",
        replace_content: { new_str: "Hello" },
      })
    ).rejects.toThrow("connection reset")
    expect(calls).toHaveLength(1)
  })

  test.each([429, 529])("retries rejected writes on HTTP %i with a bound", async (status) => {
    mockFetch(() => respond({ object: "error" }, status, { "retry-after": "0" }))
    const api = await client()
    await expect(
      api.pages.create({ markdown: "Hello", parent: { page_id: PARENT_ID } })
    ).rejects.toBeInstanceOf(NotionApiError)
    expect(calls).toHaveLength(3)
  })

  test("retries a safe read after 503", async () => {
    mockFetch(() => (calls.length === 1 ? respond({}, 503, { "retry-after": "0" }) : respond()))
    const api = await client()
    expect(await api.pages.retrieve({ page_id: PAGE_ID })).toEqual(PAGE)
    expect(calls).toHaveLength(2)
  })

  test("cancellation interrupts Retry-After without another request", async () => {
    const controller = new AbortController()
    mockFetch(() => {
      queueMicrotask(() => controller.abort())
      return respond({}, 429, { "retry-after": "60" })
    })
    const api = await client()
    await expect(
      api.pages.retrieve({ page_id: PAGE_ID }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(1)
  })

  test("runtime cancellation prevents requests", async () => {
    mockFetch()
    const controller = new AbortController()
    controller.abort()
    const api = await client({}, controller.signal)
    await expect(api.pages.retrieve({ page_id: PAGE_ID })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(calls).toHaveLength(0)
  })

  test("per-attempt timeout reaches fetch and is not retried", async () => {
    mockFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
    )
    const api = await client({ timeoutMs: 10 })
    await expect(api.pages.retrieve({ page_id: PAGE_ID })).rejects.toMatchObject({
      name: "TimeoutError",
    })
    expect(calls).toHaveLength(1)
  })

  test.each([
    "",
    "../users",
    "https://evil.example",
    "%2e%2e",
  ])("rejects invalid page ID %s before sending credentials", async (page_id) => {
    mockFetch()
    const api = await client()
    expect(() => api.pages.retrieve({ page_id })).toThrow("page_id")
    expect(calls).toHaveLength(0)
  })

  test("rejects invalid pagination, dot properties, async writes and legacy archived", async () => {
    mockFetch()
    const api = await client()
    for (const page_size of [0, 101, 1.5, Number.NaN]) {
      expect(() =>
        api.pages.properties.retrieve({ page_id: PAGE_ID, property_id: "title", page_size })
      ).toThrow("page_size")
    }
    expect(() =>
      api.pages.properties.retrieve({ page_id: PAGE_ID, property_id: "%2e%2e" })
    ).toThrow("property_id")
    expect(() =>
      api.pages.create({
        markdown: "x",
        allow_async: true,
      } as unknown as NotionCreatePageParameters)
    ).toThrow("allow_async")
    expect(() =>
      api.pages.updateMarkdown({
        page_id: PAGE_ID,
        type: "replace_content",
        replace_content: { new_str: "x" },
        allow_async: true,
      } as unknown as NotionUpdateMarkdownParameters)
    ).toThrow("allow_async")
    // @ts-expect-error Removed by Notion-Version 2026-03-11.
    expect(() => api.pages.update({ page_id: PAGE_ID, archived: true })).toThrow("in_trash")
    expect(() => api.pages.create({ markdown: "x", children: [] })).toThrow("only one")
    expect(calls).toHaveLength(0)
  })

  test("validates secrets and configuration, including resolved secrets", async () => {
    mockFetch()
    for (const token of ["", "  ", "token\nheader"])
      expect(() => notion({ token })).toThrow("token")
    for (const baseUrl of [
      "relative",
      "file:///tmp",
      "https://user:pass@example.com",
      "https://example.com/?q=1",
    ]) {
      expect(() => notion({ token: "t", baseUrl })).toThrow("baseUrl")
    }
    for (const options of [{ timeoutMs: 0 }, { minDelayMs: -1 }, { maxRetries: 1.5 }]) {
      expect(() => notion({ token: "t", ...options })).toThrow("[SixbNotion]")
    }
    const api = await client({ token: async () => "" })
    await expect(api.pages.retrieve({ page_id: PAGE_ID })).rejects.toThrow("token")
    expect(calls).toHaveLength(0)
  })
})
