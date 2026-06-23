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

describe("companycam projects", () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list sends auth, base path, and paging/query params", async () => {
    let url = ""
    let auth = ""
    let accept = ""
    mockFetch((input, init) => {
      url = String(input)
      const headers = new Headers(init?.headers)
      auth = headers.get("authorization") ?? ""
      accept = headers.get("accept") ?? ""
      return Promise.resolve(json([{ id: "p1", name: "Roof job" }]))
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    const projects = await cc.projects.list({
      perPage: 50,
      query: "roof",
      modifiedSince: "2024-01-01T00:00:00Z",
    })

    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/v2/projects")
    expect(parsed.searchParams.get("per_page")).toBe("50")
    expect(parsed.searchParams.get("query")).toBe("roof")
    expect(parsed.searchParams.get("modified_since")).toBe("2024-01-01T00:00:00Z")
    expect(parsed.searchParams.has("page")).toBe(false)
    expect(auth).toBe("Bearer tok")
    expect(accept).toBe("application/json")
    expect(projects[0]?.id).toBe("p1")
  })

  test("get hits the single-project endpoint", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json({ id: "p1" }))
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    const project = await cc.projects.get("p1")

    expect(new URL(url).pathname).toBe("/v2/projects/p1")
    expect(project.id).toBe("p1")
  })

  test("listPhotos hits the project photos endpoint with filters", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json([{ id: "ph1", project_id: "p1" }]))
    })

    const cc = await companycam({ token: "tok" }).connect(CONTEXT)
    await cc.projects.listPhotos("p1", { startDate: 1700000000, perPage: 100 })

    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/v2/projects/p1/photos")
    expect(parsed.searchParams.get("start_date")).toBe("1700000000")
    expect(parsed.searchParams.get("per_page")).toBe("100")
  })

  test("honors a custom baseUrl without a trailing slash", async () => {
    let url = ""
    mockFetch((input) => {
      url = String(input)
      return Promise.resolve(json([]))
    })

    const cc = await companycam({
      token: "tok",
      baseUrl: "https://example.test/v2",
    }).connect(CONTEXT)
    await cc.projects.list()

    expect(new URL(url).href).toBe("https://example.test/v2/projects")
  })
})
