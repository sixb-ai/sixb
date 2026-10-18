import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { defineWebhook } from "@sixb/core"
import { parseRetryAfter, type RestClient, readResponseBody, rest, withQuery } from "../src"

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as unknown as typeof fetch
}

// setImmediate is not faked by jest.useFakeTimers(), so awaiting it drains every pending
// microtask: a request that only waits on promises reaches its next timer or settles.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("rest connector", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  test("creates a rest adapter that forwards webhook definitions", () => {
    const webhook = defineWebhook("events")
      .post()
      .json()
      .handle(() => {})
    const adapter = rest({
      baseUrl: "https://api.example.com",
      webhooks: [webhook],
    })

    expect(adapter.type).toBe("rest")
    expect(adapter.webhooks).toEqual([webhook])
  })

  test("resolves relative paths against baseUrl and sends async resolver headers", async () => {
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
      async headers(context) {
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

    const response = await client.get("contacts")

    expect(response.status).toBe(200)
    expect(requestUrl).toBe("https://api.example.com/v1/contacts")
    expect(authHeader).toBe("Bearer test-token")
    expect(connectorId).toBe("hubspot")
  })

  test("refreshes once after a 401 and replays with the refreshed credentials", async () => {
    let token = "expired"
    let refreshes = 0
    const authorizations: string[] = []

    mockFetch((_, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      // A third attempt (a refresh loop) would succeed, so the regression fails fast.
      return Promise.resolve(
        authorizations.length <= 2
          ? new Response("unauthorized", { status: 401 })
          : new Response("ok", { status: 200 })
      )
    })

    const adapter = rest({
      baseUrl: "https://api.example.com",
      headers() {
        return { Authorization: `Bearer ${token}` }
      },
      async onUnauthorized() {
        refreshes += 1
        token = "refreshed"
      },
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const response = await client.get("/contacts")

    // A second 401 is returned instead of refreshing again: no bad-credential loop.
    expect(response.status).toBe(401)
    expect(authorizations).toEqual(["Bearer expired", "Bearer refreshed"])
    expect(refreshes).toBe(1)
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

  test("spaces requests by minDelayMs from when each is sent, even while headers resolve", async () => {
    // Regression check: stamp the next slot when the scheduler hands it out instead of at dispatch.
    // The first request then reaches fetch 15ms late and the second follows it 5ms later.
    jest.useFakeTimers()
    const starts: number[] = []
    mockFetch(() => {
      starts.push(performance.now())
      return Promise.resolve(new Response("ok", { status: 200 }))
    })
    let resolutions = 0
    const client = await rest({
      baseUrl: "https://api.example.com",
      minDelayMs: 20,
      headers: async () => {
        if (resolutions++ === 0) await new Promise((resolve) => setTimeout(resolve, 15))
        return {}
      },
    }).connect({
      projectId: "demo",
      connectorId: "hubspot",
      signal: new AbortController().signal,
    })

    const requests = Promise.all([client.get("/one"), client.get("/two"), client.get("/three")])
    for (let step = 0; step < 20 && starts.length < 3; step++) {
      await flush()
      jest.advanceTimersByTime(5)
    }
    await requests

    expect(starts).toHaveLength(3)
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(20)
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(20)
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
    jest.useRealTimers()
  })

  const streamBody = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
  // An always-true policy proves the mechanical gates win over any policy decision.
  const alwaysRetry = { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 }
  const defaultPolicy = { maxRetries: 2, delayMs: () => 0 }

  test.each([
    {
      request: "a stream body after a 503",
      status: 503,
      retry: alwaysRetry,
      send: (client: RestClient) => client.post("/upload", streamBody()),
    },
    {
      request: "an idempotent stream body after a 401",
      status: 401,
      retry: alwaysRetry,
      send: (client: RestClient) =>
        client.post("/upload", streamBody(), undefined, { idempotent: true }),
    },
    {
      request: "an unsafe method after a 503 by default",
      status: 503,
      retry: defaultPolicy,
      send: (client: RestClient) => client.post("/commands", { action: "run" }),
    },
    {
      request: "an unsafe method after a 401",
      status: 401,
      retry: defaultPolicy,
      send: (client: RestClient) => client.post("/commands", { action: "run" }),
    },
    {
      request: "a request marked retryable: false",
      status: 503,
      retry: alwaysRetry,
      send: (client: RestClient) => client.get("/read", undefined, { retryable: false }),
    },
    {
      request: "a request with the deprecated retry: false",
      status: 503,
      retry: alwaysRetry,
      send: (client: RestClient) => client.get("/read", { retry: false }),
    },
  ])("returns the first response without replaying $request", async ({ status, retry, send }) => {
    let attempts = 0
    let refreshes = 0
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(new Response(String(status), { status }))
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry,
      onUnauthorized() {
        refreshes += 1
      },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await send(client)

    expect(response.status).toBe(status)
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

  test("async retry policies can inspect a cloned response body", async () => {
    let attempts = 0
    let delayBody: unknown
    mockFetch(() => {
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? Response.json({ retry: true }, { status: 400 })
          : Response.json({ ok: true })
      )
    })
    const client = await rest({
      baseUrl: "https://api.example.com",
      retry: {
        maxRetries: 1,
        async shouldRetry({ response }) {
          if (!response) return false
          const body = (await response.clone().json()) as { retry?: boolean }
          return body.retry === true
        },
        async delayMs({ response }) {
          delayBody = await response?.clone().json()
          return 0
        },
      },
    }).connect({
      projectId: "demo",
      connectorId: "contract",
      signal: new AbortController().signal,
    })

    const response = await client.get("/async-retry")

    expect(attempts).toBe(2)
    expect(delayBody).toEqual({ retry: true })
    expect(await response.json()).toEqual({ ok: true })
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
    // Guard check: drop the abort listener in rest.ts sleep(); this test then times out.
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
    await flush()
    controller.abort(new DOMException("cancelled", "AbortError"))

    const error = await request.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "AbortError", message: "cancelled" })
    expect(attempts).toBe(1)
  })

  test("rejects an aborted request while it is queued behind another pacing slot", async () => {
    jest.useFakeTimers()
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
    const queued = client.get("/three", { signal: controller.signal })
    let queuedSettled = false
    queued.catch(() => {
      queuedSettled = true
    })
    controller.abort(new DOMException("cancelled", "AbortError"))
    await flush()

    // Rejected while /two still holds its pacing slot: no fake time has passed.
    expect(queuedSettled).toBe(true)
    expect(await queued.catch((error: unknown) => error)).toMatchObject({ message: "cancelled" })
    jest.advanceTimersByTime(200)
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

    const response = await client.get("/items")

    expect(response.status).toBe(200)
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
