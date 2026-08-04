import { afterEach, describe, expect, test } from "bun:test"
import { ExaApiError, type ExaConnectorOptions, type ExaSearchRequest, exa } from "../src"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Exa connector", () => {
  test("authenticates each search and sends the typed request body", async () => {
    let requestUrl = ""
    let requestInit: RequestInit | undefined
    const apiKeys: (string | null)[] = []
    const requestBodies: unknown[] = []
    let resolverCalls = 0
    mockFetch((input, init) => {
      requestUrl = String(input)
      requestInit = init
      apiKeys.push(new Headers(init?.headers).get("x-api-key"))
      requestBodies.push(JSON.parse(String(init?.body)))
      return Promise.resolve(json(searchResponse()))
    })
    const client = await connect({
      apiKey: async () => {
        resolverCalls += 1
        return `exa-test-key-${resolverCalls}`
      },
      baseUrl: "https://exa.example.test/v1",
    })

    await client.search({
      query: "sixb agents",
      numResults: 3,
      includeDomains: ["sixb.ai/docs"],
      excludeDomains: ["archive.example"],
      contents: { text: { maxCharacters: 1_500 } },
    })
    await client.search({ query: "rotated key" })

    expect(requestUrl).toBe("https://exa.example.test/v1/search")
    expect(requestInit?.method).toBe("POST")
    expect(apiKeys).toEqual(["exa-test-key-1", "exa-test-key-2"])
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json")
    expect(new Headers(requestInit?.headers).get("content-type")).toBe("application/json")
    expect(requestBodies).toEqual([
      {
        query: "sixb agents",
        numResults: 3,
        includeDomains: ["sixb.ai/docs"],
        excludeDomains: ["archive.example"],
        contents: { text: { maxCharacters: 1_500 } },
      },
      { query: "rotated key" },
    ])
    expect(resolverCalls).toBe(2)
  })

  test("returns search result, status, request, and cost wire metadata", async () => {
    const response = searchResponse()
    mockFetch(() => Promise.resolve(json(response)))

    await expect(
      (await connect({ apiKey: "test-key" })).search({ query: "sixb" })
    ).resolves.toEqual(response)
  })

  test("surfaces rate-limit and server failures after one attempt", async () => {
    for (const status of [429, 503]) {
      let attempts = 0
      mockFetch(() => {
        attempts += 1
        return Promise.resolve(
          json(
            {
              error: status === 429 ? "Rate limit exceeded" : "Service unavailable",
              tag: status === 429 ? "RATE_LIMIT" : "INTERNAL_ERROR",
              requestId: `request-${status}`,
            },
            { status }
          )
        )
      })
      const client = await connect({ apiKey: "test-key" })

      const error = await client.search({ query: "sixb" }).catch((caught) => caught)

      expect(error).toBeInstanceOf(ExaApiError)
      expect(error).toMatchObject({ status, requestId: `request-${status}` })
      expect(String(error)).toContain(`HTTP ${status}`)
      expect(attempts).toBe(1)
    }
  })

  test("surfaces network failures after one attempt", async () => {
    let attempts = 0
    mockFetch(() => {
      attempts += 1
      return Promise.reject(new Error("socket unavailable"))
    })
    const client = await connect({ apiKey: "test-key" })

    await expect(client.search({ query: "sixb" })).rejects.toThrow(
      "[SixbExa] Exa search could not reach the API."
    )
    expect(attempts).toBe(1)
  })

  test("passes caller cancellation to the active request", async () => {
    const started = Promise.withResolvers<void>()
    let receivedSignal: AbortSignal | undefined
    mockFetch((_, init) => {
      receivedSignal = init?.signal ?? undefined
      started.resolve()
      return new Promise((_, reject) => {
        const abort = (): void => reject(receivedSignal?.reason)
        if (receivedSignal?.aborted) abort()
        else receivedSignal?.addEventListener("abort", abort, { once: true })
      })
    })
    const client = await connect({ apiKey: "test-key" })
    const controller = new AbortController()
    const cancellation = new Error("caller cancelled")
    const request = client.search({ query: "sixb" }, { signal: controller.signal })
    await started.promise

    controller.abort(cancellation)

    await expect(request).rejects.toBe(cancellation)
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("honors caller cancellation while resolving credentials", async () => {
    const resolverStarted = Promise.withResolvers<void>()
    const apiKey = Promise.withResolvers<string>()
    let fetches = 0
    mockFetch(() => {
      fetches += 1
      return Promise.resolve(json(searchResponse()))
    })
    const client = await connect({
      apiKey: () => {
        resolverStarted.resolve()
        return apiKey.promise
      },
    })
    const controller = new AbortController()
    const cancellation = new Error("cancelled during credential resolution")
    const request = client.search({ query: "sixb" }, { signal: controller.signal })
    await resolverStarted.promise

    controller.abort(cancellation)

    await expect(request).rejects.toBe(cancellation)
    apiKey.resolve("resolved-too-late")
    await Bun.sleep(0)
    expect(fetches).toBe(0)
  })

  test("does not resolve credentials or fetch for a pre-aborted request", async () => {
    let resolverCalls = 0
    let fetches = 0
    mockFetch(() => {
      fetches += 1
      return Promise.resolve(json(searchResponse()))
    })
    const client = await connect({
      apiKey: () => {
        resolverCalls += 1
        return "test-key"
      },
    })
    const controller = new AbortController()
    const cancellation = new Error("already cancelled")
    controller.abort(cancellation)

    await expect(client.search({ query: "sixb" }, { signal: controller.signal })).rejects.toBe(
      cancellation
    )
    expect(resolverCalls).toBe(0)
    expect(fetches).toBe(0)
  })

  test("passes connector lifecycle cancellation to the active request", async () => {
    const started = Promise.withResolvers<void>()
    let receivedSignal: AbortSignal | undefined
    mockFetch((_, init) => {
      receivedSignal = init?.signal ?? undefined
      started.resolve()
      return new Promise((_, reject) => {
        const abort = (): void => reject(receivedSignal?.reason)
        if (receivedSignal?.aborted) abort()
        else receivedSignal?.addEventListener("abort", abort, { once: true })
      })
    })
    const lifecycle = new AbortController()
    const client = await connect({ apiKey: "test-key" }, lifecycle.signal)
    const cancellation = new Error("connector disconnected")
    const request = client.search({ query: "sixb" })
    await started.promise

    lifecycle.abort(cancellation)

    await expect(request).rejects.toBe(cancellation)
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("handles malformed and non-JSON error responses without returning their bodies", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response("<html>proxy failure with internal details</html>", { status: 502 })
      )
    )
    const client = await connect({ apiKey: "test-key" })

    const nonJson = await client.search({ query: "sixb" }).catch((error) => error)
    expect(nonJson).toBeInstanceOf(ExaApiError)
    expect(nonJson.message).toBe("[SixbExa] Exa search failed with HTTP 502.")
    expect(nonJson.message).not.toContain("proxy failure")

    mockFetch(() => Promise.resolve(json({ error: 42, requestId: {} }, { status: 400 })))
    const malformed = await client.search({ query: "sixb" }).catch((error) => error)
    expect(malformed).toBeInstanceOf(ExaApiError)
    expect(malformed.message).toBe("[SixbExa] Exa search failed with HTTP 400.")
  })

  test("redacts API keys from structured provider errors", async () => {
    const apiKey = "exa-secret-value"
    mockFetch(() =>
      Promise.resolve(
        json(
          {
            error: `Invalid credential ${apiKey}`,
            tag: `INVALID_${apiKey}`,
            requestId: `request-${apiKey}`,
          },
          { status: 401 }
        )
      )
    )
    const client = await connect({ apiKey })

    const error = await client.search({ query: "sixb" }).catch((caught) => caught)

    expect(error.message).toContain("[REDACTED]")
    expect(error.message).not.toContain(apiKey)
    expect(error.tag).toBe("INVALID_[REDACTED]")
    expect(error.requestId).toBe("request-[REDACTED]")
  })

  test("uses the canonical wire API key for requests and error redaction", async () => {
    const apiKey = "exa-padded-secret"
    let receivedApiKey = ""
    mockFetch((_input, init) => {
      receivedApiKey = new Headers(init?.headers).get("x-api-key") ?? ""
      return Promise.resolve(
        json({ error: `Invalid credential ${receivedApiKey}` }, { status: 401 })
      )
    })
    for (const resolver of [`  ${apiKey}  `, async () => `  ${apiKey}  `]) {
      const client = await connect({ apiKey: resolver })

      const error = await client.search({ query: "sixb" }).catch((caught) => caught)

      expect(receivedApiKey).toBe(apiKey)
      expect(error).toBeInstanceOf(ExaApiError)
      expect(error.message).toContain("[REDACTED]")
      expect(error.message).not.toContain(apiKey)
    }
  })

  test("validates credentials, base URLs, requests, and successful response bodies", async () => {
    expect(() => exa({ apiKey: "" })).toThrow("apiKey must not be empty")
    expect(() => exa({ apiKey: "key", baseUrl: "relative" })).toThrow(
      "baseUrl must be an absolute HTTP(S) URL"
    )

    const emptyResolverClient = await connect({ apiKey: () => "" })
    await expect(emptyResolverClient.search({ query: "sixb" })).rejects.toThrow(
      "Resolved apiKey must not be empty"
    )

    const resolverSecret = "resolver-secret"
    const failingResolverClient = await connect({
      apiKey: () => {
        throw new Error(resolverSecret)
      },
    })
    const resolverError = await failingResolverClient
      .search({ query: "sixb" })
      .catch((error) => error)
    expect(resolverError.message).toBe("[SixbExa] Could not resolve apiKey.")
    expect(resolverError.message).not.toContain(resolverSecret)
    expect(resolverError.cause).toBeUndefined()

    let syncResolverApiKey = ""
    mockFetch((_, init) => {
      syncResolverApiKey = new Headers(init?.headers).get("x-api-key") ?? ""
      return Promise.resolve(json(searchResponse()))
    })
    const syncResolverClient = await connect({ apiKey: () => "sync-resolver-key" })
    await syncResolverClient.search({ query: "sixb" })
    expect(syncResolverApiKey).toBe("sync-resolver-key")

    mockFetch(() => Promise.resolve(json({ results: {} })))
    const client = await connect({ apiKey: "test-key" })
    await expect(client.search({ query: "sixb" })).rejects.toThrow(
      "malformed response: results must be an array"
    )
    await expect(client.search({ query: " " })).rejects.toThrow("query must not be empty")
    await expect(client.search({ query: "sixb", numResults: 101 })).rejects.toThrow(
      "numResults must be an integer from 1 to 100"
    )
    await expect(
      client.search({ query: "sixb", contents: false } as unknown as ExaSearchRequest)
    ).rejects.toThrow("contents must be an object")
    await expect(
      client.search({
        query: "sixb",
        contents: { text: [] },
      } as unknown as ExaSearchRequest)
    ).rejects.toThrow("contents.text must be true or an options object")
  })
})

async function connect(
  options: ExaConnectorOptions,
  signal: AbortSignal = new AbortController().signal
) {
  return exa(options).connect({
    projectId: "exa-tests",
    connectorId: "exa",
    signal,
  })
}

function searchResponse() {
  return {
    results: [
      {
        id: "https://sixb.ai/docs",
        title: "Sixb docs",
        url: "https://sixb.ai/docs",
        publishedDate: "2026-08-03T00:00:00.000Z",
        author: "Sixb",
        text: "Connector-backed agent tools",
      },
    ],
    statuses: [{ id: "https://sixb.ai/docs", status: "success", source: "cached" }],
    requestId: "request-123",
    searchType: "auto",
    costDollars: {
      total: 0.008,
      search: { neural: 0.007 },
      contents: { text: 0.001 },
    },
  }
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init)
}

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}
