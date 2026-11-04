import { describe, expect, mock, test } from "bun:test"
import {
  createModelCatalog,
  defineLanguageModel,
  estimateModelReservation,
  type LanguageModel,
  ModelProviderError,
  rateModelCall,
  type WebSearchModel,
  type WebSearchModelRequest,
  WebSearchModelResponseError,
  type WebSearchModelResult,
} from "@sixb/core/models"
import { InMemoryStorage } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { createAiModelCallLimitController } from "../src/models/execution/model-call-limits"
import { AiModelCallRecorder } from "../src/models/execution/model-call-recorder"
import { bindWebSearchModels } from "../src/models/execution/web-search"

const projectId = "web-search"
const executionId = "test_agent_execution:run"
const usd = (amountNanos: string) => ({ currency: "USD" as const, amountNanos })

function searchModel(
  modelId: string,
  search: WebSearchModel["search"] = async () => ({ results: [] })
): WebSearchModel {
  return {
    providerId: "search",
    modelId,
    definition: { kind: "web-search", providerId: "search", modelId },
    search,
  }
}

function languageModel(modelId: string, webSearch?: WebSearchModel): LanguageModel {
  return {
    providerId: "language",
    modelId,
    definition: defineLanguageModel({
      kind: "language",
      providerId: "language",
      modelId,
      capabilities: {},
    }),
    ...(webSearch ? { webSearch } : {}),
    stream: async () => {
      throw new Error("Unexpected language call")
    },
  }
}

describe("web search catalog", () => {
  test("models.webSearch comes first, then the default language model's, then the first one's", () => {
    // Removal proof: drop either fallback in createWebSearchCatalog; its case below loses its search.
    const configured = searchModel("configured")
    const light = searchModel("light")
    const standard = searchModel("standard")

    const own = createModelCatalog({
      language: [languageModel("a", standard)],
      webSearch: [configured, searchModel("second")],
    })
    expect(own.webSearch.default.model).toBe(configured)
    expect(own.webSearch.list().map((entry) => entry.modelId)).toEqual(["configured", "second"])

    // The default is the first standard model, though the light one is listed before it.
    const tiers = createModelCatalog({
      language: { light: languageModel("x", light), standard: languageModel("y", standard) },
    })
    expect(tiers.webSearch?.default.model).toBe(standard)
    expect(tiers.webSearch?.list()).toHaveLength(1)

    const first = createModelCatalog({
      language: [languageModel("a"), languageModel("b", light), languageModel("c", standard)],
    })
    expect(first.webSearch?.default.model).toBe(light)
    expect(first.webSearch?.getByRef({ provider: "search", modelId: "light" })?.model).toBe(light)

    expect(createModelCatalog({ language: [languageModel("a")] }).webSearch).toBeUndefined()
  })

  test("an empty or malformed models.webSearch fails at startup", () => {
    expect(() => createModelCatalog({ language: [languageModel("a")], webSearch: [] })).toThrow(
      "models.webSearch must contain at least one model"
    )
    expect(() =>
      createModelCatalog({
        webSearch: [
          {
            ...searchModel("bad"),
            definition: { ...searchModel("bad").definition, modelId: "other" },
          },
        ],
      })
    ).toThrow("Expected a WebSearchModel")
  })
})

async function setup(model: WebSearchModel) {
  const storage = new InMemoryStorage()
  await createTestAgentExecution(storage, { projectId, executionId, runId: "run" })

  const recorder = new AiModelCallRecorder({
    storage,
    projectId,
    executionId,
    attempt: 1,
    requesterGroupIds: [],
    limits: createAiModelCallLimitController({ storage, projectId, requesterGroupIds: [] }),
    recoverAiModelCall: async () => {
      throw new Error("Unexpected recovery")
    },
  })

  const controller = new AbortController()
  const catalog = bindWebSearchModels(createModelCatalog({ webSearch: [model] }).webSearch, {
    signal: (signal) => (signal ? AbortSignal.any([controller.signal, signal]) : controller.signal),
    accounting: async () => recorder,
  })
  if (!catalog) throw new Error("Expected a bound catalog")

  const costLimit = (amountNanos: string) =>
    storage.aiLimits.createPolicy({
      id: "cost",
      projectId,
      subject: { type: "project" },
      limit: { meter: "cost.catalogEstimated", amount: usd(amountNanos) },
    })
  const policy = async () => (await storage.aiLimits.listPolicyStatuses({ projectId }))[0]
  const calls = async () =>
    (
      await storage.aiCosts.listModelCalls({
        projectId,
        from: new Date("2000-01-01"),
        to: new Date("2100-01-01"),
      })
    ).items

  return {
    storage,
    recorder,
    search: (request: Omit<WebSearchModelRequest, "signal">) =>
      catalog.default.model.search(request),
    costLimit,
    policy,
    calls,
  }
}

function pricedModel(
  search: (request: WebSearchModelRequest) => Promise<WebSearchModelResult>
): WebSearchModel & { search: ReturnType<typeof mock> } {
  return {
    ...searchModel("priced"),
    costEstimator: {
      estimateReservation: ({ maxResults }) => usd(String(maxResults * 1_000_000)),
      // No rate card prices a search: what a search cost is what its provider reports.
      estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
    },
    search: mock(search),
  }
}

const hit = { url: "https://example.com/a", title: "A", snippet: "About A" }

/** Priced at $1 per million tokens: its call reads 10 tokens in and writes 5. */
function pricedLanguageModel(): LanguageModel {
  const rateCard = { currency: "USD", input: "1", output: "1" } as const

  return {
    ...languageModel("priced"),
    costEstimator: {
      estimate: ({ usage }) => rateModelCall({ usage, rateCard }),
      estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard }),
    },
    async stream() {
      return {
        events: (async function* () {
          yield { type: "stream-start" as const }
          yield {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        })(),
      }
    },
  }
}

describe("web search execution", () => {
  test("admission reserves the binding's estimate for the results asked, then charges the actual", async () => {
    // Removal proof: drop reservationCost from admitCall; the cost limit refuses the search.
    let reservedDuringCall: unknown
    const model = pricedModel(async () => {
      reservedDuringCall = (await f.policy())?.consumption.reserved
      return { results: [hit], reportedCost: { money: usd("4000000") } }
    })
    const f = await setup(model)
    await f.costLimit("100000000")

    // Asked for 50, clamped to 10: the reservation prices ten results.
    const result = await f.search({ query: "  sixb  ", maxResults: 50 })

    expect(model.search.mock.calls[0]?.[0]).toMatchObject({ query: "sixb", maxResults: 10 })
    expect(result.results).toEqual([hit])
    expect(reservedDuringCall).toMatchObject({ amount: usd("10000000") })
    expect(await f.policy()).toMatchObject({
      consumption: { actual: { amount: usd("4000000") }, reserved: { amount: usd("0") } },
    })
    expect((await f.calls())[0]?.usage.modelKind).toBe("web-search")
  })

  test("a cost limit refuses a search it cannot price, or one over the limit", async () => {
    // Removal proof: fall back to a zero reservationCost in executeWebSearch when the binding has
    // no estimate; the unpriced search runs past the limit.
    const unpriced = searchModel(
      "unpriced",
      mock(async () => ({ results: [] }))
    )
    const f = await setup(unpriced)
    await f.costLimit("100000000")
    expect(await f.search({ query: "q", maxResults: 5 }).catch((error) => error)).toMatchObject({
      code: "ai.usage_limit_unavailable",
    })
    expect(unpriced.search).not.toHaveBeenCalled()

    const priced = pricedModel(async () => ({ results: [] }))
    const g = await setup(priced)
    await g.costLimit("1000000")
    expect(await g.search({ query: "q", maxResults: 5 }).catch((error) => error)).toMatchObject({
      code: "ai.usage_limit_exceeded",
    })
    expect(priced.search).not.toHaveBeenCalled()
  })

  test("a reported cost wins over the estimate", async () => {
    // Removal proof: always record the estimate in recordWebSearch; the charge becomes unknown.
    const f = await setup(
      pricedModel(async () => ({ results: [hit], reportedCost: { money: usd("5400000") } }))
    )
    await f.costLimit("100000000")

    await f.search({ query: "q", maxResults: 8 })

    expect(await f.policy()).toMatchObject({
      consumption: { actual: { amount: usd("5400000") }, reserved: { amount: usd("0") } },
    })
    expect((await f.calls())[0]?.cost).toMatchObject({ money: usd("5400000") })
  })

  test("a search that fails before replying keeps its reservation, and the limit keeps counting", async () => {
    // Removal proof: record the failed call (with empty metadata) instead of markCallUnknown in
    // executeWebSearch; the 503 is recorded unpriced, and the next search is refused with
    // ai.usage_limit_unavailable.
    const replies: (() => Promise<WebSearchModelResult>)[] = [
      async () => {
        throw new ModelProviderError("unavailable", "search", "priced", { status: 503 })
      },
      async () => {
        throw new TypeError("fetch failed")
      },
      async () => ({ results: [hit], reportedCost: { money: usd("4000000") } }),
    ]
    const model = pricedModel(async () => {
      const reply = replies.shift()
      if (!reply) throw new Error("Unexpected search")
      return reply()
    })
    const f = await setup(model)
    await f.costLimit("1000000000")

    // Whether the provider charged is unknown: each failure holds the reservation it was admitted with.
    expect(await f.search({ query: "q", maxResults: 5 }).catch((error) => error)).toMatchObject({
      status: 503,
    })
    expect(await f.search({ query: "q", maxResults: 5 }).catch((error) => error)).toMatchObject({
      message: "fetch failed",
    })
    expect((await f.search({ query: "q", maxResults: 5 })).results).toEqual([hit])
    expect(await f.policy()).toMatchObject({
      consumption: {
        actual: { amount: usd("4000000") },
        reserved: { amount: usd("0") },
        unknown: { amount: usd("10000000") },
      },
    })
    expect(await f.calls()).toHaveLength(1)

    // A language call under the same limit still runs.
    const language = f.recorder.wrapModel(pricedLanguageModel())
    const stream = await language.stream({
      callId: "call-language",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })
    for await (const _event of stream.events) {
      // Each event is read.
    }

    expect((await f.policy())?.consumption.actual).toMatchObject({ amount: usd("4015000") })
  })

  test("a binding that resolves to another model is refused before it searches", async () => {
    // Removal proof: drop the identity check after resolve() in executeWebSearch; the other
    // model's search runs and the call is recorded under the binding's name.
    const other = pricedModel(async () => ({ results: [hit] }))
    const model = {
      ...pricedModel(async () => ({ results: [hit] })),
      resolve: async () => ({
        ...other,
        modelId: "other",
        definition: { ...other.definition, modelId: "other" },
      }),
    }
    const f = await setup(model)

    const refused = await f.search({ query: "q", maxResults: 3 }).catch((error) => error)

    expect((refused as Error).message).toBe(
      "[SixbModels] Resolved web search model identity does not match its binding."
    )
    expect(other.search).not.toHaveBeenCalled()
    expect(model.search).not.toHaveBeenCalled()
  })

  test("a cost limit refuses a search whose reservation estimate throws", async () => {
    // Removal proof: drop the try/catch in estimateReservationCost; the estimator's own error
    // escapes instead of the limit's refusal.
    const model = pricedModel(async () => ({ results: [hit] }))
    const f = await setup({
      ...model,
      costEstimator: {
        ...model.costEstimator,
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
        estimateReservation: () => {
          throw new Error("No price for this engine")
        },
      },
    })
    await f.costLimit("1000000000")

    expect(await f.search({ query: "q", maxResults: 3 }).catch((error) => error)).toMatchObject({
      code: "ai.usage_limit_unavailable",
    })
    expect(model.search).not.toHaveBeenCalled()
  })

  test("a malformed billable reply is recorded, then refused", async () => {
    // Removal proof: record only after validateWebSearchHits; neither call below is accounted.
    const replies: (() => Promise<WebSearchModelResult>)[] = [
      async () => ({
        results: [{ url: "ftp://example.com", title: "A", snippet: "" }],
        reportedCost: { money: usd("5400000") },
      }),
      async () => {
        throw new WebSearchModelResponseError("tool not called", "search", "priced", {
          reportedCost: { money: usd("400000") },
        })
      },
    ]
    const model = pricedModel(async () => {
      const reply = replies.shift()
      if (!reply) throw new Error("Unexpected search")
      return reply()
    })
    const f = await setup(model)

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.search({ query: "q", maxResults: 3 }).catch((error) => error)).toMatchObject({
        code: "invalid_web_search_response",
      })
    }

    expect(model.search).toHaveBeenCalledTimes(2)
    const recorded = (await f.calls()).map((call) => call.cost)
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ money: usd("5400000") }),
        expect.objectContaining({ money: usd("400000") }),
      ])
    )
  })

  test("hits are trimmed, cut and dated by Sixb", async () => {
    const f = await setup(
      pricedModel(async () => ({
        results: [
          { ...hit, title: " A ", snippet: "x".repeat(400), publishedAt: "2026-11-01" },
          { ...hit, publishedAt: "last week" },
          hit,
        ],
      }))
    )

    const { results } = await f.search({ query: "q", maxResults: 2 })

    expect(results).toEqual([
      { ...hit, snippet: `${"x".repeat(300)}…`, publishedAt: "2026-11-01T00:00:00.000Z" },
      hit,
    ])
  })
})
