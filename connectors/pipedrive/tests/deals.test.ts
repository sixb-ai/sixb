import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PipedriveApiError, pipedrive } from "../src"
import { CONTEXT, collect, json, mockFetch } from "./helpers"

describe("pipedrive deals", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list sends API-token auth and v2 query params", async () => {
    let requested = ""
    let apiToken = ""
    let accept = ""
    mockFetch((input, init) => {
      requested = String(input)
      const headers = new Headers(init?.headers)
      apiToken = headers.get("x-api-token") ?? ""
      accept = headers.get("accept") ?? ""
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)
    await client.deals.list({
      limit: 50,
      ids: [1, 2],
      updated_since: "2026-01-01T00:00:00Z",
      include_labels: true,
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/api/v2/deals")
    expect(url.searchParams.get("limit")).toBe("50")
    expect(url.searchParams.get("ids")).toBe("1,2")
    expect(url.searchParams.get("updated_since")).toBe("2026-01-01T00:00:00Z")
    expect(url.searchParams.get("include_labels")).toBe("true")
    expect(apiToken).toBe("pd-token")
    expect(accept).toBe("application/json")
  })

  test("get and search hit exact v2 paths", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: {} }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.deals.get(123, { include_labels: true })
    await client.deals.search({ term: "roof", exact_match: true, limit: 20 })

    expect(paths).toEqual([
      "/api/v2/deals/123?include_labels=true",
      "/api/v2/deals/search?term=roof&exact_match=true&limit=20",
    ])
  })

  test("listAll follows v2 cursor pagination", async () => {
    const cursors: (string | null)[] = []
    mockFetch((input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor")
      cursors.push(cursor)
      return Promise.resolve(
        json(
          cursor
            ? { success: true, data: [{ id: 2 }], additional_data: { next_cursor: null } }
            : { success: true, data: [{ id: 1 }], additional_data: { next_cursor: "next" } }
        )
      )
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    const deals = await collect(client.deals.listAll({ limit: 1 }))

    expect(cursors).toEqual([null, "next"])
    expect(deals.map((deal) => deal.id)).toEqual([1, 2])
  })

  test("throws PipedriveApiError on non-2xx responses", async () => {
    mockFetch(() =>
      Promise.resolve(json({ error: "bad token" }, { status: 401, statusText: "Unauthorized" }))
    )

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    const promise = client.deals.list()

    await expect(promise).rejects.toBeInstanceOf(PipedriveApiError)
    await expect(promise).rejects.toThrow("401")
    await expect(promise).rejects.toThrow("bad token")
  })
})
