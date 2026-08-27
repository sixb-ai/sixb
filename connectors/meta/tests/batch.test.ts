import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { MetaResponseMetadata } from "../src"
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

function readBatchBody(init: RequestInit | undefined): readonly {
  readonly method: string
  readonly relative_url: string
}[] {
  const form = new URLSearchParams(String(init?.body))
  return JSON.parse(form.get("batch") ?? "[]")
}

describe("meta connector — batch", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("executes GET-only reads with per-request tokens and independent results", async () => {
    let method = ""
    let authorization = ""
    let submitted: ReturnType<typeof readBatchBody> = []
    const observed: MetaResponseMetadata[] = []
    mockFetch((_input, init) => {
      method = init?.method ?? ""
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      submitted = readBatchBody(init)
      return Promise.resolve(
        json(
          [
            {
              code: 200,
              headers: [
                {
                  name: "X-Business-Use-Case-Usage",
                  value: JSON.stringify({
                    "page-1": [{ type: "pages", call_count: 12, total_time: 3 }],
                  }),
                },
              ],
              body: JSON.stringify({ id: "page-1" }),
            },
            {
              code: 400,
              body: JSON.stringify({
                error: { message: "Invalid token", type: "OAuthException", code: 190 },
              }),
            },
          ],
          {
            headers: {
              "X-App-Usage": JSON.stringify({ call_count: 7, total_cputime: 2, total_time: 4 }),
            },
          }
        )
      )
    })

    const client = await meta({
      accessToken: "user-token",
      onResponse(metadata) {
        observed.push(metadata)
      },
    }).connect(CONTEXT)
    const [page, failure] = await client.batch.execute([
      client.batch.get<{ readonly id: string }>("page-1?fields=id", {
        accessToken: "page-token",
      }),
      client.batch.get("ig-1?fields=id"),
    ] as const)

    expect(method).toBe("POST")
    expect(authorization).toBe("Bearer user-token")
    expect(submitted).toEqual([
      { method: "GET", relative_url: "page-1?fields=id&access_token=page-token" },
      { method: "GET", relative_url: "ig-1?fields=id" },
    ])
    expect(page.ok).toBe(true)
    if (page.ok) expect(page.body.id).toBe("page-1")
    expect(failure.ok).toBe(false)
    if (!failure.ok) expect(failure.error?.code).toBe(190)
    expect(observed.find((entry) => entry.batchIndex === undefined)?.usage.app?.call_count).toBe(7)
    expect(
      observed.find((entry) => entry.batchIndex === 0)?.usage.businessUseCase?.["page-1"]?.[0]?.type
    ).toBe("pages")
  })

  test("retries only throttled sub-requests and preserves input order", async () => {
    const submitted: ReturnType<typeof readBatchBody>[] = []
    mockFetch((_input, init) => {
      submitted.push(readBatchBody(init))
      return Promise.resolve(
        submitted.length === 1
          ? json([
              { code: 200, body: JSON.stringify({ id: "first" }) },
              {
                code: 400,
                headers: [{ name: "Retry-After", value: "0" }],
                body: JSON.stringify({ error: { message: "Rate limited", code: 4 } }),
              },
            ])
          : json([{ code: 200, body: JSON.stringify({ id: "second" }) }])
      )
    })

    const client = await meta({
      accessToken: "token",
      retry: { maxRetries: 1, delayMs: () => 0 },
    }).connect(CONTEXT)
    const results = await client.batch.execute([
      client.batch.get<{ readonly id: string }>("first?fields=id"),
      client.batch.get<{ readonly id: string }>("second?fields=id"),
    ] as const)

    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual([{ method: "GET", relative_url: "second?fields=id" }])
    expect(results.map((result) => (result.ok ? result.body.id : "error"))).toEqual([
      "first",
      "second",
    ])
  })

  test("marks the outer POST as replayable because every sub-request is a GET", async () => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? json({ error: { message: "Unavailable" } }, { status: 503 })
          : json([{ code: 200, body: JSON.stringify({ id: "ok" }) }])
      )
    })

    const client = await meta({
      accessToken: "token",
      retry: { maxRetries: 1, delayMs: () => 0 },
    }).connect(CONTEXT)
    const [result] = await client.batch.execute([client.batch.get("node?fields=id")] as const)

    expect(attempts).toBe(2)
    expect(result.ok).toBe(true)
  })

  test("rejects empty, oversized, and absolute batches before requesting", async () => {
    let called = false
    mockFetch(() => {
      called = true
      return Promise.resolve(json([]))
    })
    const client = await meta({ accessToken: "token" }).connect(CONTEXT)

    await expect(client.batch.execute([])).rejects.toThrow("between 1 and 50")
    await expect(
      client.batch.execute(Array.from({ length: 51 }, (_, index) => client.batch.get(`${index}`)))
    ).rejects.toThrow("between 1 and 50")
    await expect(
      client.batch.execute([client.batch.get("https://example.com/node")])
    ).rejects.toThrow("must not be absolute")
    expect(called).toBe(false)
  })
})
