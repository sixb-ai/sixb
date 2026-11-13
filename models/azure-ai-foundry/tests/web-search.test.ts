import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  ModelProviderError,
  UnsupportedModelFeatureError,
  WebSearchModelResponseError,
} from "@sixb/core/models"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const responsesUrl = `${endpoint}/openai/v1/responses`

const nanoDeployment = {
  type: "ModelDeployment",
  name: "nano",
  modelName: "gpt-5.4-nano",
  modelVersion: "2026-03-17",
  modelPublisher: "OpenAI",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard", capacity: 20 },
}
const deepseekDeployment = {
  ...nanoDeployment,
  name: "deepseek",
  modelName: "DeepSeek-V4",
  modelPublisher: "DeepSeek",
}
const ttsDeployment = {
  ...nanoDeployment,
  name: "tts",
  modelName: "gpt-4o-mini-tts",
  capabilities: {},
}

const result = (url: string, title: string, snippet: string) => ({
  type: "text_result",
  url,
  title,
  snippet,
})

// Azure's reply with `include: ["web_search_call.results"]`: a reasoning item, the search, the
// model's one-word answer.
const searchReply = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "nano",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "chiller trips" },
      results: [
        result("https://a.example/one", "One", "First snippet"),
        result("https://b.example/two", "Two", "Second snippet"),
        result("https://a.example/one", "One again", "Duplicate"),
        result("https://c.example/three", "Three", "Third snippet"),
      ],
    },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ],
  usage: {
    input_tokens: 8_000,
    input_tokens_details: { cached_tokens: 3_000, cache_write_tokens: 0 },
    output_tokens: 60,
    output_tokens_details: { reasoning_tokens: 55 },
    total_tokens: 8_060,
  },
}

type Fetch = NonNullable<AzureAIFoundryOptions["fetch"]>

/** Discovery answers from `deployments`; every other request goes to `inference`. */
function foundry(
  inference: Fetch,
  options: Partial<AzureAIFoundryOptions> & { deployments?: unknown[] } = {}
) {
  const calls: string[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "secret-key",
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
    ...options,
    fetch: async (url, init) => {
      calls.push(new URL(String(url)).pathname)
      if (new URL(String(url)).pathname.endsWith("/deployments"))
        return Response.json({
          value: options.deployments ?? [nanoDeployment, deepseekDeployment, ttsDeployment],
        })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.webSearch()", () => {
  test("asks the deployment for one web_search call and returns that call's results", async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return Response.json(searchReply, { headers: { "apim-request-id": "request-1" } })
    })
    const binding = provider.webSearch("nano")
    expect(calls).toEqual([])
    expect(binding.definition).toEqual({
      kind: "web-search",
      providerId: "azure-ai-foundry",
      modelId: "nano",
      via: "Azure AI Foundry",
    })

    const model = await binding.resolve()
    const found = await model.search({
      query: "chiller trips",
      maxResults: 2,
      allowedDomains: ["https://Learn.Microsoft.com/en-us/", "learn.microsoft.com"],
      blockedDomains: ["reddit.com"],
    })

    // The project's inference URL routes Responses, like the language bindings.
    expect(request?.url).toBe(responsesUrl)
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("application/json")
    expect(request?.body).toEqual({
      model: "nano",
      instructions:
        "Run exactly one web search for the user's query, as written. Then reply with the single word: done.",
      input: "chiller trips",
      tools: [
        {
          type: "web_search",
          filters: { allowed_domains: ["learn.microsoft.com"], blocked_domains: ["reddit.com"] },
        },
      ],
      tool_choice: "required",
      max_tool_calls: 1,
      include: ["web_search_call.results"],
      reasoning: { effort: "low" },
      store: false,
    })
    expect(found.results).toEqual([
      { url: "https://a.example/one", title: "One", snippet: "First snippet" },
      { url: "https://b.example/two", title: "Two", snippet: "Second snippet" },
    ])
    expect(found).toMatchObject({
      responseModelId: "nano",
      providerIds: { requestId: "request-1", responseId: "resp_1" },
      usage: { inputTokens: 8_000, outputTokens: 60, cacheReadInputTokens: 3_000 },
    })
    expect(model.definition.publisher).toEqual({ id: "openai", name: "OpenAI" })
    // Azure reports no search count and the Retail Prices API lists no search fee.
    expect(model.costEstimator).toBeUndefined()
  })

  test("a caller's estimator prices it; reasoning is configurable", async () => {
    let body: Record<string, unknown> | undefined
    const { provider } = foundry(async (_, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json(searchReply)
    })
    const estimate = () => ({
      status: "unpriceable" as const,
      reason: "missing-rate-card" as const,
    })
    const model = await provider
      .webSearch("nano", { reasoning: "high", costEstimator: { estimate } })
      .resolve()
    await model.search({ query: "x", maxResults: 10 })
    expect(body?.reasoning).toEqual({ effort: "high" })
    expect(body).not.toHaveProperty("tools.0.filters")
    expect(model.costEstimator?.estimate).toBe(estimate)
    for (const reasoning of ["huge", "minimal", "none", "provider-default", "max"])
      expect(() => provider.webSearch("nano", { reasoning: reasoning as never })).toThrow(
        "reasoning must be one of low, medium, high, xhigh"
      )
  })

  test("maps Sixb's domain rules to the hostnames Azure filters by", async () => {
    let filters: unknown
    const { provider } = foundry(async (_, init) => {
      filters = JSON.parse(String(init?.body)).tools[0].filters
      return Response.json(searchReply)
    })
    const model = await provider.webSearch("nano").resolve()
    await model.search({
      query: "x",
      maxResults: 3,
      allowedDomains: ["*.example.com", "docs.example.org/guides", "Example.net"],
      blockedDomains: [
        "spam.example",
        "*.ads.example",
        "example.com/private",
        "https://bad.example/",
      ],
    })
    // Allowed rules widen to their host; only bare blocked hosts are sent.
    expect(filters).toEqual({
      allowed_domains: ["example.com", "docs.example.org", "example.net"],
      blocked_domains: ["spam.example", "bad.example"],
    })
    await model.search({ query: "x", maxResults: 3, blockedDomains: ["*.ads.example"] })
    expect(filters).toBeUndefined()
  })

  test("runs only on an OpenAI language deployment", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const deepseek = await provider
      .webSearch("deepseek")
      .resolve()
      .catch((e: unknown) => e)
    expect(deepseek).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(deepseek)).toContain("web search needs an OpenAI reasoning model")
    const chat = await foundry(async () => Response.json(searchReply), {
      deployments: [{ ...nanoDeployment, modelName: "gpt-4.1-mini" }],
    })
      .provider.webSearch("nano")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(chat)).toContain("needs an OpenAI reasoning model")
    const speech = await provider
      .webSearch("tts")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(speech)).toContain("not a language model. Use foundry.speech()")
    expect(() => provider.webSearch(" nano")).toThrow("deploymentName")
    expect(() => provider.webSearch("nano", { timeoutMs: 0 })).toThrow("timeoutMs")
  })

  test("an unresolved binding resolves once on its first direct call", async () => {
    let posts = 0
    const { provider, calls } = foundry(async () => {
      posts++
      return Response.json(searchReply)
    })
    const binding = provider.webSearch("nano")
    await binding.search({ query: "x", maxResults: 3 })
    await binding.search({ query: "x", maxResults: 3 })
    expect(posts).toBe(2)
    expect(calls.filter((path) => path.endsWith("/deployments"))).toHaveLength(1)
  })
})

describe("web search errors", () => {
  test("a reply without a search, or without its results, keeps the usage", async () => {
    const replies = [
      { ...searchReply, output: [searchReply.output[2]] },
      {
        ...searchReply,
        output: [{ ...searchReply.output[1], results: undefined }, searchReply.output[2]],
      },
    ]
    const messages = ["ran no web search", "no results list: use a model with reasoning"]
    for (const [index, reply] of replies.entries()) {
      const model = await foundry(async () => Response.json(reply))
        .provider.webSearch("nano")
        .resolve()
      const error = await model.search({ query: "x", maxResults: 3 }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(WebSearchModelResponseError)
      expect(String(error)).toContain(messages[index]!)
      expect(error).toMatchObject({ metadata: { usage: { inputTokens: 8_000 } } })
    }
    const invalid = await foundry(async () => new Response("{"))
      .provider.webSearch("nano")
      .resolve()
    expect(
      await invalid.search({ query: "x", maxResults: 3 }).catch((e: unknown) => e)
    ).toMatchObject({ code: "invalid_json" })
  })

  test("a rejection keeps Azure's message; throttling is not replayed", async () => {
    // Removal proof: drop "web-search" from ONE_SHOT in transport.ts; the 429 is posted thrice.
    let posts = 0
    const { provider } = foundry(
      async () => {
        posts++
        return posts === 1
          ? Response.json(
              {
                error: {
                  code: "tool_not_enabled",
                  message: "Web Search tool is not enabled for this subscription.",
                },
              },
              { status: 400 }
            )
          : new Response(null, { status: 429, headers: { "retry-after-ms": "0" } })
      },
      { maxRetries: 2 }
    )
    const model = await provider.webSearch("nano").resolve()
    const rejected = await model.search({ query: "x", maxResults: 3 }).catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(ModelProviderError)
    expect(rejected).toMatchObject({ status: 400, code: "tool_not_enabled", retryable: false })
    const throttled = await model.search({ query: "x", maxResults: 3 }).catch((e: unknown) => e)
    expect(throttled).toMatchObject({ status: 429, retryable: true })
    expect(posts).toBe(2)
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.webSearch("nano", { timeoutMs: 5 }).resolve()
    expect(
      await timed.search({ query: "x", maxResults: 3 }).catch((e: unknown) => e)
    ).toMatchObject({ name: "TimeoutError" })
    const controller = new AbortController()
    const model = await provider.webSearch("nano").resolve()
    const pending = model
      .search({ query: "x", maxResults: 3, signal: controller.signal })
      .catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })
})

describe("in a project", () => {
  test("registers in models.webSearch beside the language deployment it searches with", () => {
    const { provider } = foundry(async () => Response.json(searchReply))
    expect(
      () =>
        new SixbHost({
          id: "foundry-web-search",
          ontology: [],
          models: { language: [provider.chat("nano")], webSearch: [provider.webSearch("nano")] },
          storage: new InMemoryStorage(),
          broker: new InMemoryBroker(),
          queues: new InMemoryQueues(),
          blobStorage: new InMemoryBlobStorage(),
          lakeStorage: new InMemoryLakeStorage(),
        })
    ).not.toThrow()
  })
})
