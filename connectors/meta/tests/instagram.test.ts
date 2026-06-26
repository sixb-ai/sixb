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

describe("meta connector — instagram", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("media.list requests default fields and preserves carousel children", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(
        json({
          data: [
            {
              id: "m1",
              media_type: "CAROUSEL_ALBUM",
              like_count: 3,
              children: { data: [{ id: "c1", media_url: "u1" }, { id: "c2" }] },
            },
          ],
        })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.instagram("ig-1").media.list()

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/ig-1/media")
    expect(url.searchParams.get("fields")).toContain("like_count")
    expect(url.searchParams.get("fields")).toContain(
      "children{id,media_type,media_url,permalink,timestamp,thumbnail_url}"
    )
    expect(page.items[0]?.children?.map((child) => child.id)).toEqual(["c1", "c2"])
  })

  test("media.list with metrics adds an inline insights expansion and parses insights", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(
        json({
          data: [
            {
              id: "m1",
              insights: { data: [{ name: "views", total_value: { value: 42 } }] },
            },
          ],
        })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.instagram("ig-1").media.list({
      metrics: ["views", "total_interactions"],
    })

    expect(new URL(requested).searchParams.get("fields")).toContain(
      "insights.metric(views,total_interactions)"
    )
    expect(page.items[0]?.insights?.[0]?.name).toBe("views")
  })

  test("media.listAll follows the after cursor across pages", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        calls.length === 1
          ? json({
              data: [{ id: "m1" }],
              paging: { cursors: { after: "C1" }, next: "https://graph.facebook.com/x" },
            })
          : json({ data: [{ id: "m2" }] })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const ids: string[] = []
    for await (const media of client.instagram("ig-1").media.listAll()) {
      ids.push(media.id)
    }

    expect(calls).toHaveLength(2)
    expect(new URL(calls[1] ?? "").searchParams.get("after")).toBe("C1")
    expect(ids).toEqual(["m1", "m2"])
  })

  test("stories.list hits the stories edge with story fields", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ data: [{ id: "s1", media_product_type: "STORY" }] }))
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.instagram("ig-1").stories.list()

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/ig-1/stories")
    expect(url.searchParams.get("fields")).not.toContain("children")
    expect(page.items[0]?.id).toBe("s1")
  })

  test("stories.list with metrics adds an inline insights expansion", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    await client.instagram("ig-1").stories.list({ metrics: ["reach", "replies"] })

    expect(new URL(requested).searchParams.get("fields")).toContain(
      "insights.metric(reach,replies)"
    )
  })

  test("get fetches the IG user profile node with default fields", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(
        json({ id: "ig-1", username: "acme", followers_count: 601, follows_count: 12 })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const user = await client.instagram("ig-1").get()

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/ig-1")
    expect(url.searchParams.get("fields")).toContain("follows_count")
    expect(user.username).toBe("acme")
    expect(user.follows_count).toBe(12)
  })

  test("rejects an empty ig user id before requesting", () => {
    const promise = meta({ accessToken: "t" })
      .connect(CONTEXT)
      .then((client) => client.instagram("  "))
    expect(promise).rejects.toThrow("igUserId must not be empty")
  })
})
