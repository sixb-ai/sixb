import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { meta } from "../src"

const CONTEXT = {
  projectId: "demo",
  connectorId: "meta",
  signal: new AbortController().signal,
}

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as unknown as typeof fetch
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

describe("meta connector — pages", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("connects with meta auth headers and a versioned base path", async () => {
    let auth = ""
    let accept = ""
    let url = ""
    mockFetch((input, init) => {
      const headers = new Headers(init?.headers)
      auth = headers.get("authorization") ?? ""
      accept = headers.get("accept") ?? ""
      url = String(input)
      return Promise.resolve(json({ data: [] }))
    })

    const adapter = meta({ accessToken: "tok-123" })
    const client = await adapter.connect(CONTEXT)
    await client.pages.list()

    expect(adapter.type).toBe("meta")
    expect(auth).toBe("Bearer tok-123")
    expect(accept).toBe("application/json")
    expect(new URL(url).pathname).toBe("/v23.0/me/accounts")
  })

  test("pages.list requests the default field expansion and parses pages", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(
        json({
          data: [
            {
              id: "page-1",
              name: "Acme",
              access_token: "page-tok",
              instagram_business_account: {
                id: "ig-1",
                username: "acme",
                followers_count: 10,
                media_count: 5,
              },
            },
          ],
        })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.pages.list()

    const url = new URL(requested)
    expect(url.searchParams.get("fields")).toContain(
      "instagram_business_account{id,username,name,followers_count,media_count}"
    )
    expect(url.searchParams.get("limit")).toBe("100")
    expect(page.items[0]?.access_token).toBe("page-tok")
    expect(page.items[0]?.instagram_business_account?.username).toBe("acme")
  })

  test("pages.listAll follows the after cursor and does not dedup", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        calls.length === 1
          ? json({
              data: [{ id: "page-1" }, { id: "page-1" }],
              paging: { cursors: { after: "CURSOR1" }, next: "https://graph.facebook.com/next" },
            })
          : json({ data: [{ id: "page-2" }], paging: { cursors: { after: "CURSOR2" } } })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const ids: string[] = []
    for await (const page of client.pages.listAll()) {
      ids.push(page.id)
    }

    expect(calls).toHaveLength(2)
    expect(new URL(calls[1] ?? "").searchParams.get("after")).toBe("CURSOR1")
    // Raw passthrough: duplicates from page one are preserved, not deduped by the connector.
    expect(ids).toEqual(["page-1", "page-1", "page-2"])
  })

  test("honors a custom graph version", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "t", graphVersion: "v21.0" }).connect(CONTEXT)
    await client.pages.list()

    expect(new URL(url).pathname).toBe("/v21.0/me/accounts")
  })

  test("rejects an empty access token before connecting", () => {
    expect(() => meta({ accessToken: "  " })).toThrow("accessToken must not be empty")
  })
})
