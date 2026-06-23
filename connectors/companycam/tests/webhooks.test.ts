import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CompanyCamApiError, companycam } from "../src"

const CONTEXT = {
  projectId: "demo",
  connectorId: "companycam",
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

describe("companycam webhooks resource", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("create posts the subscription and defaults token to webhookSecret", async () => {
    let url = ""
    let method = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      url = String(input)
      method = init?.method ?? ""
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: "wh1", url: payload.url, enabled: true }, { status: 201 }))
    })

    const cc = await companycam({ token: "tok", webhookSecret: "s3cret" }).connect(CONTEXT)
    const webhook = await cc.webhooks.create({
      url: "https://app.example/api/webhooks/companycam/events",
      scopes: ["project.created", "photo.created"],
    })

    expect(new URL(url).pathname).toBe("/v2/webhooks")
    expect(method).toBe("POST")
    expect(payload.scopes).toEqual(["project.created", "photo.created"])
    expect(payload.enabled).toBe(true)
    expect(payload.token).toBe("s3cret")
    expect(webhook.id).toBe("wh1")
  })

  test("create respects an explicit token and enabled flag", async () => {
    let payload: Record<string, unknown> = {}
    mockFetch((_, init) => {
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: "wh2" }, { status: 201 }))
    })

    const cc = await companycam({ token: "tok", webhookSecret: "s3cret" }).connect(CONTEXT)
    await cc.webhooks.create({
      url: "https://app.example/hook",
      scopes: ["project.created"],
      enabled: false,
      token: "override",
    })

    expect(payload.token).toBe("override")
    expect(payload.enabled).toBe(false)
  })

  test("update issues a PUT and delete issues a DELETE", async () => {
    const calls: { method: string; path: string }[] = []
    mockFetch((input, init) => {
      calls.push({ method: init?.method ?? "", path: new URL(String(input)).pathname })
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({ id: "wh1", enabled: false })
      )
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    await cc.webhooks.update("wh1", { enabled: false })
    await cc.webhooks.delete("wh1")

    expect(calls).toEqual([
      { method: "PUT", path: "/v2/webhooks/wh1" },
      { method: "DELETE", path: "/v2/webhooks/wh1" },
    ])
  })

  test("throws CompanyCamApiError on a non-2xx response", async () => {
    mockFetch(() => Promise.resolve(json({ message: "Unprocessable" }, { status: 422 })))
    const cc = await companycam({ token: "tok" }).connect(CONTEXT)

    const promise = cc.webhooks.create({ url: "https://x", scopes: ["project.created"] })
    await expect(promise).rejects.toBeInstanceOf(CompanyCamApiError)
    await expect(promise).rejects.toThrow("422")
  })
})
