import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { MetaApiError, meta } from "../src"

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

describe("meta connector — insights", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  test("account insights send metric, period, metric_type and unix-second windows", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(
        json({
          data: [
            { name: "views", total_value: { value: 1 } },
            { name: "total_interactions", total_value: { value: 2 } },
          ],
        })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const insights = await client.instagram("ig-1").insights.get({
      metrics: ["views", "total_interactions"],
      period: "day",
      metricType: "total_value",
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/ig-1/insights")
    expect(url.searchParams.get("metric")).toBe("views,total_interactions")
    expect(url.searchParams.get("period")).toBe("day")
    expect(url.searchParams.get("metric_type")).toBe("total_value")
    expect(url.searchParams.get("since")).toBe(String(Date.parse("2026-01-01T00:00:00Z") / 1000))
    expect(url.searchParams.get("until")).toBe(String(Date.parse("2026-01-02T00:00:00Z") / 1000))
    // Returned in API order — no reordering by the connector.
    expect(insights.map((insight) => insight.name)).toEqual(["views", "total_interactions"])
  })

  test("empty metrics resolve to no request", async () => {
    let called = false
    mockFetch(() => {
      called = true
      return Promise.resolve(json({ data: [] }))
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const insights = await client.instagram("ig-1").insights.get({ metrics: [] })

    expect(insights).toEqual([])
    expect(called).toBe(false)
  })

  test("page insights apply the page token override and omit an unset metric_type", async () => {
    let auth = ""
    let requested = ""
    mockFetch((input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? ""
      requested = String(input)
      return Promise.resolve(json({ data: [{ name: "page_media_view" }] }))
    })

    const client = await meta({ accessToken: "user-tok" }).connect(CONTEXT)
    await client
      .facebook("page-1", { accessToken: "page-tok" })
      .insights.get({ metrics: ["page_media_view"], period: "day" })

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/page-1/insights")
    expect(url.searchParams.get("period")).toBe("day")
    expect(url.searchParams.has("metric_type")).toBe(false)
    expect(auth).toBe("Bearer page-tok")
  })

  test("media insights hit the media node insights edge", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ data: [{ name: "reach" }] }))
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const insights = await client.instagramMedia("m1").insights.get({ metrics: ["reach"] })

    const url = new URL(requested)
    expect(url.pathname).toBe("/v23.0/m1/insights")
    expect(url.searchParams.get("metric")).toBe("reach")
    expect(insights[0]?.name).toBe("reach")
  })

  test("throws MetaApiError on a non-2xx response", async () => {
    mockFetch(() =>
      Promise.resolve(
        json(
          {
            error: {
              message: "Invalid metric",
              type: "OAuthException",
              code: 100,
              error_subcode: 33,
              fbtrace_id: "trace-1",
            },
          },
          {
            status: 400,
            headers: {
              "X-App-Usage": JSON.stringify({ call_count: 18, total_cputime: 2, total_time: 4 }),
            },
          }
        )
      )
    )

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const promise = client.instagram("ig-1").insights.get({ metrics: ["bogus"] })

    await expect(promise).rejects.toBeInstanceOf(MetaApiError)
    await expect(promise).rejects.toThrow("400")
    const error = (await promise.catch((caught: unknown) => caught)) as MetaApiError
    expect(error.graphError).toEqual({
      message: "Invalid metric",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      is_transient: undefined,
      error_user_title: undefined,
      error_user_msg: undefined,
      error_data: undefined,
      fbtrace_id: "trace-1",
    })
    expect(error.usage.app?.call_count).toBe(18)
    expect(error.body).toEqual({
      error: {
        message: "Invalid metric",
        type: "OAuthException",
        code: 100,
        error_subcode: 33,
        fbtrace_id: "trace-1",
      },
    })
    expect(JSON.parse(error.rawBody)).toEqual(error.body)
  })

  test.each([
    { code: 4, calls: 2 },
    { code: 190, calls: 1 },
  ])("retries an HTTP 400 only for Meta throttling codes (code $code)", async ({ code, calls }) => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? json({ error: { message: "Rejected", code } }, { status: 400 })
          : json({ data: [{ name: "reach" }] })
      )
    })

    const client = await meta({
      accessToken: "t",
      retry: { maxRetries: 2, delayMs: () => 0 },
    }).connect(CONTEXT)
    const result = await client
      .instagram("ig-1")
      .insights.get({ metrics: ["reach"] })
      .catch((error: unknown) => error)

    expect(attempts).toBe(calls)
    if (calls === 1) expect(result).toBeInstanceOf(MetaApiError)
    else expect(result).toEqual([expect.objectContaining({ name: "reach" })])
  })

  // Regression proof: make the default delayMs ignore Retry-After (1000ms backoff); it must fail.
  test("retries 429 responses after the Retry-After delay by default", async () => {
    jest.useFakeTimers()
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? json(
              { error: { message: "rate limited" } },
              { status: 429, headers: { "Retry-After": "2" } }
            )
          : json({ data: [{ name: "reach" }] })
      )
    })

    const client = await meta({ accessToken: "t" }).connect(CONTEXT)
    const insights = client.instagram("ig-1").insights.get({ metrics: ["reach"] })
    for (let turn = 0; turn < 100 && jest.getTimerCount() === 0; turn++) await Promise.resolve()

    jest.advanceTimersByTime(1_999)
    await Promise.resolve()
    expect(calls).toBe(1)
    jest.advanceTimersByTime(1)

    expect((await insights)[0]?.name).toBe("reach")
    expect(calls).toBe(2)
  })
})
