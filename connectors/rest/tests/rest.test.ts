import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { defineWebhook } from "@sixb/core"
import { rest } from "../src"

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
