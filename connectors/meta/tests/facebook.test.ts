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

describe("meta connector — facebook", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts.list unwraps summary counts and keeps every attachment", async () => {
    mockFetch(() =>
      Promise.resolve(
        json({
          data: [
            {
              id: "p1",
              message: "hi",
              created_time: "2026-01-01T00:00:00+0000",
              comments: { summary: { total_count: 4 } },
              reactions: { summary: { total_count: 9 } },
              shares: { count: 2 },
              attachments: {
                data: [
                  { type: "photo", url: "u1" },
                  { type: "video", url: "u2" },
                ],
              },
            },
          ],
        })
      )
    )

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.facebook("page-1").posts.list()
    const post = page.items[0]

    expect(post?.comments_count).toBe(4)
    expect(post?.reactions_count).toBe(9)
    expect(post?.shares_count).toBe(2)
    expect(post?.created_time).toBe("2026-01-01T00:00:00+0000") // raw passthrough, not coerced
    expect(post?.attachments?.map((attachment) => attachment.url)).toEqual(["u1", "u2"])
  })

  test("posts.list applies a page access token override and serializes since to unix seconds", async () => {
    let auth = ""
    let requested = ""
    mockFetch((input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? ""
      requested = String(input)
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "user-tok" }).connect(CONTEXT)
    await client.facebook("page-1", { accessToken: "page-tok" }).posts.list({
      since: new Date("2026-01-01T00:00:00Z"),
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/page-1/published_posts")
    expect(auth).toBe("Bearer page-tok") // overrides the default user token
    expect(url.searchParams.get("since")).toBe(
      String(Math.trunc(Date.parse("2026-01-01T00:00:00Z") / 1000))
    )
  })

  test("posts.list with metrics adds a lifetime insights expansion", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    await client.facebook("page-1").posts.list({ metrics: ["post_media_view"] })

    expect(new URL(requested).searchParams.get("fields")).toContain(
      "insights.metric(post_media_view).period(lifetime)"
    )
  })

  test("get fetches the page profile node with audience fields and the page token", async () => {
    let auth = ""
    let requested = ""
    mockFetch((input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? ""
      requested = String(input)
      return Promise.resolve(
        json({ id: "page-1", name: "Acme", fan_count: 100, followers_count: 120 })
      )
    })

    const client = await meta({ accessToken: "user-tok" }).connect(CONTEXT)
    const profile = await client.facebook("page-1", { accessToken: "page-tok" }).get()

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/page-1")
    expect(url.searchParams.get("fields")).toContain("fan_count")
    expect(auth).toBe("Bearer page-tok")
    expect(profile.followers_count).toBe(120)
  })

  test("falls back to the default token when no page token is given", async () => {
    let auth = ""
    mockFetch((_, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? ""
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "user-tok" }).connect(CONTEXT)
    await client.facebook("page-1").posts.list()

    expect(auth).toBe("Bearer user-tok")
  })
})
