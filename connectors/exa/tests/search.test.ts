import { afterEach, describe, expect, test } from "bun:test"
import { createModelCatalog, ModelProviderError } from "@sixb/core/models"
import { exaSearch } from "../src"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** An Exa `/search` reply with highlights, as Exa returns it. */
function reply(extra: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    resolvedSearchType: "neural",
    results: [
      {
        id: "https://bun.com/blog/bun-v1.4",
        title: "Bun 1.4",
        url: "https://bun.com/blog/bun-v1.4",
        publishedDate: "2026-08-20T00:53:44.000Z",
        author: null,
        highlights: ["Bun is the complete toolkit", "for full-stack JavaScript"],
      },
      {
        id: "https://example.com/notes",
        title: null,
        url: "https://example.com/notes",
        text: "Release notes",
      },
    ],
    costDollars: { total: 0.007, search: { neural: 0.007 } },
    ...extra,
  }
}

function exa(respond: () => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return respond()
  }) as typeof fetch

  return requests
}

describe("Exa web search", () => {
  test("sends one /search with highlights, capped at its own maxResults", async () => {
    const requests = exa(() => Response.json(reply()))
    const model = exaSearch({
      apiKey: "exa-key",
      baseUrl: "https://exa.test/v1",
      type: "fast",
      maxResults: 5,
    })

    await model.search({ query: "bun 1.4", maxResults: 10 })

    const [request] = requests
    expect(request?.url).toBe("https://exa.test/v1/search")
    expect(request?.headers.get("x-api-key")).toBe("exa-key")
    expect(request?.body).toEqual({
      query: "bun 1.4",
      type: "fast",
      numResults: 5,
      contents: { highlights: true },
    })
    expect(model.definition).toEqual({ kind: "web-search", providerId: "exa", modelId: "fast" })
  })

  test("sends the allowed domains, else the blocked ones", async () => {
    // Removal proof: drop `domainFilter` from the body; no request carries a domain list.
    const requests = exa(() => Response.json(reply()))
    const model = exaSearch({ apiKey: "exa-key" })

    await model.search({ query: "q", maxResults: 3, allowedDomains: ["bun.com"] })
    await model.search({ query: "q", maxResults: 3, blockedDomains: ["spam.example"] })
    await model.search({
      query: "q",
      maxResults: 3,
      allowedDomains: ["bun.com"],
      blockedDomains: ["spam.example"],
    })
    await model.search({ query: "q", maxResults: 3, allowedDomains: [], blockedDomains: [] })

    expect(
      requests.map(({ body }) => ({
        include: body.includeDomains,
        exclude: body.excludeDomains,
      }))
    ).toEqual([
      { include: ["bun.com"], exclude: undefined },
      { include: undefined, exclude: ["spam.example"] },
      { include: ["bun.com"], exclude: undefined },
      { include: undefined, exclude: undefined },
    ])
  })

  test("reads results as hits, with the cost Exa reports", async () => {
    exa(() => Response.json(reply()))

    const result = await exaSearch({ apiKey: "exa-key" }).search({ query: "q", maxResults: 8 })

    expect(result).toEqual({
      providerIds: { requestId: "request-1" },
      reportedCost: { money: { currency: "USD", amountNanos: "7000000" }, providerId: "exa" },
      results: [
        {
          url: "https://bun.com/blog/bun-v1.4",
          title: "Bun 1.4",
          snippet: "Bun is the complete toolkit … for full-stack JavaScript",
          publishedAt: "2026-08-20T00:53:44.000Z",
        },
        { url: "https://example.com/notes", title: "", snippet: "Release notes" },
      ],
    })
  })

  test("reserves a fixed ceiling, and is found as the project's search", () => {
    const model = exaSearch({ apiKey: "exa-key" })

    expect(model.costEstimator?.estimateReservation?.({ maxResults: 10 })).toEqual({
      currency: "USD",
      amountNanos: "10000000",
    })
    expect(createModelCatalog({ webSearch: [model] }).webSearch?.default.model).toBe(model)
  })

  test("an HTTP error is a provider error with its status", async () => {
    exa(() =>
      Response.json(
        { error: "Too many requests", tag: "RATE_LIMITED", requestId: "request-2" },
        { status: 429 }
      )
    )

    const error = await exaSearch({ apiKey: "exa-key" })
      .search({ query: "q", maxResults: 3 })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).toMatchObject({
      providerId: "exa",
      modelId: "auto",
      status: 429,
      code: "RATE_LIMITED",
      requestId: "request-2",
      retryable: true,
    })
  })

  test("a reply Exa billed but Sixb cannot read is a response error that keeps its charge", async () => {
    // Removal proof: rethrow the parser's error in `parseExaSearchResponse` without its
    // `costDollars`; the metadata below loses its reported cost.
    exa(() => Response.json(reply({ results: "none" })))

    const error = await exaSearch({ apiKey: "exa-key" })
      .search({ query: "q", maxResults: 3 })
      .catch((caught) => caught)

    expect(error).toMatchObject({
      code: "invalid_web_search_response",
      retryable: false,
      metadata: { reportedCost: { money: { amountNanos: "7000000" } } },
    })
  })

  test("rejects options it cannot honor", () => {
    expect(() => exaSearch({ apiKey: "" })).toThrow("apiKey must not be empty")
    expect(() => exaSearch({ apiKey: "k", maxResults: 11 })).toThrow("from 1 to 10")
    // @ts-expect-error -- deliberately unsupported
    expect(() => exaSearch({ apiKey: "k", type: "deep" })).toThrow('"auto" or "fast"')
  })
})
