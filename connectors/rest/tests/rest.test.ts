import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { defineWebhook } from "@sixb/core"
import { parseRetryAfter, readResponseBody, rest, withQuery } from "../src"

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as unknown as typeof fetch
}

describe("rest connector", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("creates a rest adapter", async () => {
    mockFetch(() => Promise.resolve(new Response("ok", { status: 200 })))

    const adapter = rest({ baseUrl: "https://api.example.com" })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/status")
    expect(adapter.type).toBe("rest")
    expect(response.status).toBe(200)
  })

  test("forwards webhook definitions", () => {
    const webhook = defineWebhook("events")
      .post()
      .json()
      .handle(() => {})
    const adapter = rest({
      baseUrl: "https://api.example.com",
      webhooks: [webhook],
    })

    expect(adapter.webhooks).toEqual([webhook])
  })

  test("resolves relative paths against baseUrl and merges async headers", async () => {
    let requestUrl = ""
    let authHeader = ""
    let connectorId = ""

    mockFetch((input, init) => {
      requestUrl = String(input)
      authHeader = new Headers(init?.headers).get("authorization") ?? ""
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const adapter = rest({
      baseUrl: "https://api.example.com/v1/",
      headers(context) {
        connectorId = context.connectorId
        return {
          Authorization: "Bearer test-token",
        }
      },
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    await client.get("contacts")

    expect(requestUrl).toBe("https://api.example.com/v1/contacts")
    expect(authHeader).toBe("Bearer test-token")
    expect(connectorId).toBe("hubspot")
  })

  test("retries once after unauthorized refresh callback", async () => {
    let token = "expired"
    let attempts = 0

    mockFetch((_, init) => {
      attempts += 1
      const authorization = new Headers(init?.headers).get("authorization")
      return Promise.resolve(
        authorization === "Bearer refreshed"
          ? new Response("ok", { status: 200 })
          : new Response("unauthorized", { status: 401 })
      )
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      headers() {
        return { Authorization: `Bearer ${token}` }
      },
      async onUnauthorized() {
        token = "refreshed"
      },
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/contacts")

    expect(response.status).toBe(200)
    expect(attempts).toBe(2)
  })

  test("does not charge an unauthorized refresh against the transient retry budget", async () => {
    let attempts = 0

    mockFetch(() => {
      attempts += 1
      const status = [401, 503, 503, 200][attempts - 1] ?? 500
      return Promise.resolve(new Response(String(status), { status }))
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      onUnauthorized: () => Promise.resolve(),
      retry: { maxRetries: 2, delayMs: () => 0 },
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/contacts")

    expect(response.status).toBe(200)
    expect(attempts).toBe(4)
  })

  test("retries based on retry policy", async () => {
    let attempts = 0

    mockFetch(() => {
      attempts += 1
      return Promise.resolve(
        attempts === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 })
      )
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      retry: {
        maxRetries: 1,
        delayMs() {
          return 0
        },
      },
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/contacts")

    expect(response.status).toBe(200)
    expect(attempts).toBe(2)
  })

  test("allows an individual request to opt out of retries", async () => {
    let attempts = 0

    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("busy", { status: 503 }))
    })

    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 3, delayMs: () => 0 },
    }).connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/read", { retry: false })

    expect(response.status).toBe(503)
    expect(attempts).toBe(1)
  })

  test("aborts while waiting for retry backoff", async () => {
    const controller = new AbortController()
    let attempts = 0
    let markFetched: (() => void) | undefined
    const fetched = new Promise<void>((resolve) => {
      markFetched = resolve
    })

    mockFetch(() => {
      attempts += 1
      markFetched?.()
      return Promise.resolve(new Response("busy", { status: 503 }))
    })

    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 1, delayMs: () => 1_000 },
    }).connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: controller.signal,
    })

    const request = client.get("/contacts", { signal: controller.signal })
    await fetched
    await Promise.resolve()
    controller.abort(new DOMException("Stopped", "AbortError"))

    const settled = Promise.race([
      request.then(
        () => "resolved",
        (error: unknown) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])
    expect(await settled).toBeInstanceOf(DOMException)
    expect(attempts).toBe(1)
  })

  test("spaces concurrent requests when minDelayMs is configured", async () => {
    const starts: number[] = []
    mockFetch(() => {
      starts.push(Date.now())
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const client = await rest({
      baseUrl: "https://api.example.com",
      minDelayMs: 20,
    }).connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    await Promise.all([client.get("/one"), client.get("/two"), client.get("/three")])

    expect(starts).toHaveLength(3)
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(15)
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(15)
  })

  test("never retries a request with a stream body — it cannot be replayed", async () => {
    let attempts = 0

    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("busy", { status: 503 }))
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 3, delayMs: () => 0 },
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    const response = await client.post("/upload", body)

    // The real 503 surfaces instead of a masked "stream already used" error.
    expect(response.status).toBe(503)
    expect(attempts).toBe(1)
  })

  test("never replays a stream body after a 401 refresh", async () => {
    let attempts = 0

    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("unauthorized", { status: 401 }))
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      onUnauthorized: () => Promise.resolve(),
    })
    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
    const response = await client.post("/upload", body)

    expect(response.status).toBe(401)
    expect(attempts).toBe(1)
  })

  test("serializes json bodies for post requests", async () => {
    let requestBody = ""
    let contentType = ""

    mockFetch((_, init) => {
      requestBody = String(init?.body)
      contentType = new Headers(init?.headers).get("content-type") ?? ""
      return Promise.resolve(new Response("created", { status: 201 }))
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.post("/contacts", { name: "Alice" })

    expect(response.status).toBe(201)
    expect(requestBody).toBe(JSON.stringify({ name: "Alice" }))
    expect(contentType).toBe("application/json")
  })
})

describe("rest reliability contract", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("does not retry an unsafe method by default", async () => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("busy", { status: 503 }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 2, delayMs: () => 0 },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await client.post("/commands", { action: "run" })

    expect(response.status).toBe(503)
    expect(attempts).toBe(1)
  })

  test("does not refresh and replay an unsafe method after a 401", async () => {
    let attempts = 0
    let refreshes = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("unauthorized", { status: 401 }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      onUnauthorized() {
        refreshes += 1
      },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await client.post("/commands", { action: "run" })

    expect(response.status).toBe(401)
    expect(attempts).toBe(1)
    expect(refreshes).toBe(0)
  })

  test("retries an explicitly idempotent post with a replayable body", async () => {
    const bodies: string[] = []
    const contexts: Array<{
      method: string
      path: string
      idempotent: boolean
      bodyReplayable: boolean
    }> = []
    mockFetch((_input, init) => {
      bodies.push(String(init?.body))
      return Promise.resolve(
        bodies.length === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: true })
      )
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: {
        maxRetries: 1,
        shouldRetry(context) {
          contexts.push({
            method: context.method,
            path: context.path,
            idempotent: context.idempotent,
            bodyReplayable: context.bodyReplayable,
          })
          return context.response?.status === 503
        },
        delayMs: () => 0,
      },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await client.post("/query", { ids: ["one"] }, undefined, { idempotent: true })

    expect(await response.json()).toEqual({ ok: true })
    expect(bodies).toEqual(['{"ids":["one"]}', '{"ids":["one"]}'])
    expect(contexts).toEqual([
      { method: "POST", path: "/query", idempotent: true, bodyReplayable: true },
    ])
  })

  test("a hard retry gate wins over a custom policy", async () => {
    let attempts = 0
    let decisions = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("busy", { status: 503 }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: {
        maxRetries: 2,
        shouldRetry() {
          decisions += 1
          return true
        },
        delayMs: () => 0,
      },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    await client.get("/unsafe-read", undefined, { retryable: false })

    expect(attempts).toBe(1)
    expect(decisions).toBe(0)
  })

  test("never retries an abort", async () => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.reject(new DOMException("aborted", "AbortError"))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    await expect(client.get("/items")).rejects.toThrow("aborted")
    expect(attempts).toBe(1)
  })

  test("an abort interrupts retry backoff", async () => {
    const controller = new AbortController()
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("busy", { status: 503 }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 2, delayMs: () => 5_000 },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: controller.signal,
    })

    const request = client.get("/items")
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 10)

    await expect(request).rejects.toThrow("cancelled")
    expect(attempts).toBe(1)
  })

  test("serializes concurrent request starts", async () => {
    const starts: number[] = []
    mockFetch(() => {
      starts.push(Date.now())
      return Promise.resolve(new Response("ok"))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      minDelayMs: 20,
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    await Promise.all([client.get("/one"), client.get("/two"), client.get("/three")])

    expect(starts).toHaveLength(3)
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(15)
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(15)
  })

  test("rejects an aborted request while it is queued behind another pacing slot", async () => {
    const controller = new AbortController()
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response("ok"))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      minDelayMs: 200,
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    await client.get("/one")
    const blocker = client.get("/two")
    const startedAt = Date.now()
    const queued = client.get("/three", { signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 10)

    await expect(queued).rejects.toThrow("cancelled")
    expect(Date.now() - startedAt).toBeLessThan(100)
    await blocker
    expect(attempts).toBe(2)
  })

  test("resolves dynamic headers for every attempt", async () => {
    const authorizations: string[] = []
    let token = 0
    mockFetch((_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      return Promise.resolve(
        authorizations.length === 1 ? new Response("busy", { status: 503 }) : new Response("ok")
      )
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      headers: () => ({ Authorization: `Bearer ${++token}` }),
      retry: { maxRetries: 1, delayMs: () => 0 },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    await client.get("/items")

    expect(authorizations).toEqual(["Bearer 1", "Bearer 2"])
  })

  test("stops after maxRetries and returns the final response", async () => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response(`busy ${attempts}`, { status: 503 }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: { maxRetries: 2, delayMs: () => 0 },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await client.get("/items")

    expect(response.status).toBe(503)
    expect(await response.text()).toBe("busy 3")
    expect(attempts).toBe(3)
  })

  test("parses Retry-After, query encodings, and response bodies centrally", async () => {
    const now = Date.parse("2026-08-20T12:00:00Z")
    expect(parseRetryAfter("2", now)).toBe(2_000)
    expect(parseRetryAfter("Thu, 20 Aug 2026 12:00:05 GMT", now)).toBe(5_000)
    expect(parseRetryAfter("invalid", now)).toBeNull()

    expect(
      withQuery(
        "/items",
        { status: ["pending", "sent"], empty: "", missing: undefined },
        { omitEmptyString: true }
      )
    ).toBe("items?status=pending&status=sent")
    expect(withQuery("items", { status: ["pending", "sent"] }, { arrayFormat: "comma" })).toBe(
      "items?status=pending%2Csent"
    )

    expect(await readResponseBody(Response.json({ ok: true }))).toEqual({ ok: true })
    expect(await readResponseBody(new Response("plain text"))).toBe("plain text")
    expect(await readResponseBody(new Response(null, { status: 204 }))).toBeUndefined()
  })

  test("rejects invalid reliability options when connecting", () => {
    const context = {
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    }
    expect(() =>
      rest({ baseUrl: "https://api.example.com", retry: { maxRetries: -1 } }).connect(context)
    ).toThrow("retry.maxRetries must be a non-negative integer")
    expect(() =>
      rest({ baseUrl: "https://api.example.com", minDelayMs: Number.NaN }).connect(context)
    ).toThrow("minDelayMs must be a non-negative finite number")
  })
})
