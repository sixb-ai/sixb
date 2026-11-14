import { afterEach, describe, expect, test } from "bun:test"
import { meta } from "../src"

const CONTEXT = {
  projectId: "demo",
  connectorId: "meta",
  signal: new AbortController().signal,
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function recordRequests(respond: (url: URL) => Response): URL[] {
  const urls: URL[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input))
    urls.push(url)
    return Promise.resolve(respond(url))
  }) as typeof fetch
  return urls
}

describe("meta connector — ads", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("business edges list owned, client and pending ad accounts with default fields", async () => {
    const urls = recordRequests(() => json({ data: [{ id: "act_1", name: "Brewery" }] }))
    const client = await meta({ accessToken: "system-user" }).connect(CONTEXT)
    const business = client.ads.business("502")

    const owned = await business.ownedAdAccounts.list()
    await business.clientAdAccounts.list({ fields: ["id"], limit: 25 })
    await business.pendingClientAdAccounts.list()

    expect(owned.items).toEqual([{ id: "act_1", name: "Brewery" }])
    expect(urls.map((url) => url.pathname.split("/").slice(2).join("/"))).toEqual([
      "502/owned_ad_accounts",
      "502/client_ad_accounts",
      "502/pending_client_ad_accounts",
    ])
    expect(urls[0]?.searchParams.get("fields")).toContain("business{id,name}")
    expect(urls[1]?.searchParams.get("fields")).toBe("id")
    expect(urls[1]?.searchParams.get("limit")).toBe("25")
    expect(urls[2]?.searchParams.get("fields")).toContain("owner_business{id,name}")
  })

  test("listAll follows the after cursor and keeps every requested field", async () => {
    const urls = recordRequests((url) =>
      url.searchParams.get("after")
        ? json({ data: [{ id: "c2", custom_field: 2 }] })
        : json({
            data: [{ id: "c1", custom_field: 1 }],
            paging: { cursors: { after: "cursor-1" }, next: "https://graph.facebook.com/next" },
          })
    )
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const campaigns = []
    for await (const campaign of client.ads.account("123").campaigns.listAll({
      fields: ["id", "custom_field"],
      effectiveStatus: ["ACTIVE", "ARCHIVED"],
      updatedSince: new Date("2026-01-01T00:00:00Z"),
    })) {
      campaigns.push(campaign)
    }

    expect(campaigns).toEqual([
      { id: "c1", custom_field: 1 },
      { id: "c2", custom_field: 2 },
    ])
    expect(urls[0]?.pathname.endsWith("/act_123/campaigns")).toBe(true)
    expect(urls[0]?.searchParams.get("effective_status")).toBe('["ACTIVE","ARCHIVED"]')
    expect(JSON.parse(urls[0]?.searchParams.get("filtering") ?? "[]")).toEqual([
      { field: "updated_time", operator: "GREATER_THAN", value: 1767225600 },
    ])
    expect(urls[1]?.searchParams.get("after")).toBe("cursor-1")
  })

  test("listAll fails when Meta announces a page without a usable cursor", async () => {
    recordRequests(() =>
      json({ data: [{ id: "c1" }], paging: { next: "https://graph.facebook.com/next" } })
    )
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const read = async () => {
      for await (const _ of client.ads.account("1").campaigns.listAll()) {
        // drain
      }
    }
    await expect(read()).rejects.toThrow("without a new cursor")
  })

  test("insights send the time range, level, increment and breakdowns", async () => {
    const urls = recordRequests(() =>
      json({
        data: [
          {
            date_start: "2026-10-01",
            date_stop: "2026-10-01",
            campaign_id: "c1",
            spend: "12.5",
            results: [{ indicator: "actions:link_click", values: [{ value: "7" }] }],
          },
        ],
      })
    )
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const page = await client.ads.account("act_123").insights.list({
      level: "campaign",
      timeRange: { since: "2026-10-01", until: "2026-10-09" },
      timeIncrement: 1,
      breakdowns: ["publisher_platform"],
    })

    expect(page.items[0]?.results?.[0]?.values?.[0]?.value).toBe("7")
    const url = urls[0]
    expect(url?.pathname.endsWith("/act_123/insights")).toBe(true)
    expect(url?.searchParams.get("level")).toBe("campaign")
    expect(url?.searchParams.get("time_range")).toBe('{"since":"2026-10-01","until":"2026-10-09"}')
    expect(url?.searchParams.get("time_increment")).toBe("1")
    expect(url?.searchParams.get("breakdowns")).toBe("publisher_platform")
    expect(url?.searchParams.get("fields")).toContain("cost_per_result")
  })

  test("insights reject an invalid time range before calling Meta", async () => {
    const urls = recordRequests(() => json({ data: [] }))
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    await expect(
      client.ads.account("123").insights.list({
        timeRange: { since: "2026-10-09", until: "2026-10-01" },
      })
    ).rejects.toThrow("timeRange")
    expect(urls).toHaveLength(0)
  })

  test("account ids must be act_<digits> or digits", async () => {
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    expect(() => client.ads.account("act_x/../me")).toThrow("adAccountId")
  })

  test("ad creatives send the thumbnail size", async () => {
    const urls = recordRequests(() => json({ data: [] }))
    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    await client.ads.account("123").adCreatives.list({ thumbnailSize: { width: 480, height: 480 } })
    expect(urls[0]?.searchParams.get("thumbnail_width")).toBe("480")
    expect(urls[0]?.searchParams.get("thumbnail_height")).toBe("480")
  })

  test("a business-use-case limit is retried as throttling", async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? json({ error: { message: "User request limit reached", code: 80000 } }, { status: 400 })
          : json({ data: [{ id: "act_1" }] })
      )
    }) as unknown as typeof fetch
    const client = await meta({
      accessToken: "t",
      retry: { maxRetries: 1, delayMs: () => 0 },
    }).connect(CONTEXT)
    const page = await client.ads.adAccounts.list()
    expect(page.items).toEqual([{ id: "act_1" }])
    expect(calls).toBe(2)
  })
})
