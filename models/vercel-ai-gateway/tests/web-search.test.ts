import { describe, expect, test } from "bun:test"
import { createModelCatalog, ModelProviderError } from "@sixb/core/models"
import { createVercelGateway } from "../src"

const gatewayCost = { cost: "0.0054872", generationId: "gen_123" }

/** A Gateway reply as /v4/ai/language-model returns it: the call, its raw result, then the text. */
function reply(toolName: string, result: unknown, extra: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "tool-call", toolCallId: "call", toolName, input: "{}", providerExecuted: true },
      { type: "tool-result", toolCallId: "call", toolName, result, ...extra },
      { type: "text", text: "OK" },
    ],
    usage: { inputTokens: { total: 4457 }, outputTokens: { total: 16 } },
    providerMetadata: { gateway: gatewayCost },
  }
}

function gateway(respond: (url: string, init: RequestInit | undefined) => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const provider = createVercelGateway({
    baseUrl: "https://gateway.test/proxy/v1",
    apiKey: () => "test-key",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      return respond(String(url), init)
    },
  })
  return { provider, requests }
}

describe("Gateway web search", () => {
  test("forces one search tool on the wrapper model, its query pinned in the arguments", async () => {
    // Removal proof: drop `query` from the perplexity args or `toolChoice` from the body; the
    // request below no longer matches.
    const controller = new AbortController()
    const { provider, requests } = gateway(() =>
      Response.json(reply("perplexity_search", { id: "s", results: [] }), {
        headers: { "x-request-id": "request-1" },
      })
    )

    await provider.webSearch().search({
      query: "bun 1.4",
      maxResults: 10,
      blockedDomains: ["spam.example"],
      signal: controller.signal,
    })

    const [request] = requests
    expect(request?.url).toBe("https://gateway.test/proxy/v4/ai/language-model")
    expect(Object.fromEntries(request?.headers ?? [])).toMatchObject({
      authorization: "Bearer test-key",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-language-model-specification-version": "4",
      "ai-language-model-id": "google/gemini-2.5-flash-lite",
      "ai-language-model-streaming": "false",
    })
    expect(request?.body).toMatchObject({
      prompt: [{ role: "system" }, { role: "user", content: [{ type: "text", text: "bun 1.4" }] }],
      tools: [
        {
          type: "provider",
          id: "gateway.perplexity_search",
          name: "perplexity_search",
          // The binding's default of 8 caps the 10 asked for.
          args: { query: "bun 1.4", maxResults: 8, searchDomainFilter: ["-spam.example"] },
        },
      ],
      toolChoice: { type: "tool", toolName: "perplexity_search" },
      maxOutputTokens: 100,
    })
  })

  test("reads each engine's results as hits, with the cost Gateway reports", async () => {
    const cases = [
      {
        engine: "perplexity" as const,
        result: {
          id: "s",
          results: [
            { title: "Bun 1.4", url: "https://bun.com/a", snippet: "Fast", date: "2026-08-20" },
          ],
        },
        args: { query: "q", maxResults: 3 },
      },
      {
        engine: "exa" as const,
        result: {
          requestId: "r",
          results: [
            {
              id: "https://bun.com/a",
              title: "Bun 1.4",
              url: "https://bun.com/a",
              publishedDate: "2026-08-20",
              highlights: ["Fast", "Faster"],
            },
          ],
        },
        args: {
          query: "q",
          numResults: 3,
          contents: { highlights: true },
          includeDomains: ["bun.com"],
        },
      },
      {
        engine: "parallel" as const,
        result: {
          search_id: "s",
          results: [
            {
              url: "https://bun.com/a",
              title: "Bun 1.4",
              publish_date: "2026-08-20",
              excerpts: ["Fast", "Faster"],
            },
          ],
        },
        args: {
          objective: "q",
          searchQueries: ["q"],
          maxResults: 3,
          sourcePolicy: { includeDomains: ["bun.com"] },
        },
      },
    ]

    for (const { engine, result, args } of cases) {
      const { provider, requests } = gateway(() =>
        Response.json(reply(`${engine}_search`, result), {
          headers: { "x-request-id": "request-1" },
        })
      )
      const model = provider.webSearch(engine)

      const found = await model.search({
        query: "q",
        maxResults: 3,
        ...(engine === "perplexity" ? {} : { allowedDomains: ["bun.com"] }),
      })

      expect(model.definition).toEqual({
        kind: "web-search",
        providerId: "vercel-ai-gateway",
        modelId: `${engine}/search`,
      })
      expect(requests[0]?.body.tools).toMatchObject([{ args }])
      expect(found).toMatchObject({
        results: [
          {
            url: "https://bun.com/a",
            title: "Bun 1.4",
            snippet: engine === "perplexity" ? "Fast" : "Fast … Faster",
            publishedAt: "2026-08-20",
          },
        ],
        providerIds: { requestId: "request-1", generationId: "gen_123" },
        reportedCost: { money: { currency: "USD", amountNanos: "5487200" } },
      })
    }
  })

  test("reserves a fixed ceiling per engine, and nothing for a wrapper it cannot price", () => {
    const { provider } = gateway(() => Response.json({}))
    const reservation = (model: ReturnType<typeof provider.webSearch>) =>
      model.costEstimator?.estimateReservation?.({ maxResults: 8 })

    expect(reservation(provider.webSearch("perplexity"))).toEqual({
      currency: "USD",
      amountNanos: "7000000",
    })
    expect(reservation(provider.webSearch("exa"))?.amountNanos).toBe("10000000")
    expect(reservation(provider.webSearch("parallel"))?.amountNanos).toBe("7000000")
    expect(
      reservation(provider.webSearch("perplexity", { wrapperModel: "openai/gpt-5" }))
    ).toBeUndefined()
  })

  test("a search the tool did not run is a response error that keeps its charge", async () => {
    // Removal proof: return an empty list when no tool result is found; the first case succeeds.
    const replies = [
      { ...reply("perplexity_search", {}), content: [{ type: "text", text: "No." }] },
      reply("perplexity_search", { error: "rate_limit", message: "Slow down" }, { isError: true }),
      reply("perplexity_search", { error: "api_error", message: "Upstream failed" }),
      reply("perplexity_search", { id: "s", results: "none" }),
    ]

    for (const body of replies) {
      const { provider } = gateway(() => Response.json(body))
      const error = await provider
        .webSearch()
        .search({ query: "q", maxResults: 3 })
        .catch((caught) => caught)

      expect(error).toMatchObject({
        code: "invalid_web_search_response",
        retryable: false,
        metadata: { reportedCost: { money: { amountNanos: "5487200" } } },
      })
    }
  })

  test("an HTTP error is a provider error with its status", async () => {
    const { provider } = gateway(() =>
      Response.json(
        { error: { message: "Too many requests", type: "rate_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "2", "x-request-id": "request-1" } }
      )
    )

    const error = await provider
      .webSearch()
      .search({ query: "q", maxResults: 3 })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      retryable: true,
      retryAfterMs: 2_000,
      requestId: "request-1",
    })
  })

  test("a Gateway-only project searches with its language models' Perplexity", () => {
    // Removal proof: stop passing the provider's webSearch to VercelGatewayLanguageModel; the
    // catalog finds no search.
    const { provider } = gateway(() => Response.json({}))
    const light = provider("google/gemini-2.5-flash-lite")
    const standard = provider("anthropic/claude-sonnet-4.5")

    const catalog = createModelCatalog({ language: { light, standard } })

    expect(catalog.webSearch?.default.model).toBe(standard.webSearch)
    expect(catalog.webSearch?.default).toMatchObject({
      provider: "vercel-ai-gateway",
      modelId: "perplexity/search",
    })
    expect(light.webSearch).toBe(standard.webSearch)
  })

  test("a resolved language model keeps the same search", async () => {
    const { provider } = gateway(() => Response.json({}))
    const model = provider("anthropic/claude-sonnet-4.5")

    const resolved = await model.resolve?.({ offline: true })

    expect(resolved).not.toBe(model)

    expect(resolved?.webSearch).toBe(model.webSearch)
  })
})
