import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { companycam } from "../src"

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

describe("companycam photos", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list serializes array filters with bracket params", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json([{ id: "ph1" }, { id: "ph2" }]))
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    const photos = await cc.photos.list({ projectIds: ["a", "b"], startDate: 5 })

    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/v2/photos")
    expect(parsed.searchParams.getAll("project_ids[]")).toEqual(["a", "b"])
    expect(parsed.searchParams.get("start_date")).toBe("5")
    expect(photos.map((photo) => photo.id)).toEqual(["ph1", "ph2"])
  })

  test("get hits the single-photo endpoint", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json({ id: "ph1" }))
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    const photo = await cc.photos.get("ph1")

    expect(new URL(url).pathname).toBe("/v2/photos/ph1")
    expect(photo.id).toBe("ph1")
  })
})
