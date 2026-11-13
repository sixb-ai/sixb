import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  type EmbeddingModel,
  ModelProviderError,
  RerankingModelResponseError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const rerankUrl = "https://resource.services.ai.azure.com/providers/cohere/v2/rerank"

// The records Azure's project discovery returned for Cohere rerank deployments. v4 claims chat.
const v5Deployment = {
  type: "ModelDeployment",
  name: "rerank-v5",
  modelName: "Cohere-rerank-v5-fast",
  modelVersion: "1",
  modelPublisher: "Cohere",
  capabilities: {},
  sku: { name: "GlobalStandard", capacity: 10 },
}
const v4Deployment = {
  type: "ModelDeployment",
  name: "rerank-v4",
  modelName: "Cohere-rerank-v4.0-fast",
  modelVersion: "1",
  modelPublisher: "Cohere",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard", capacity: 10 },
}
const chatDeployment = {
  type: "ModelDeployment",
  name: "chat",
  modelName: "future-chat",
  modelVersion: "1",
  modelPublisher: "Fixture",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard" },
}

// Azure's replies: v5 bills input tokens, v4 search units.
const v5Reply = {
  id: "rerank-1",
  results: [
    { index: 0, relevance_score: 0.47 },
    { index: 2, relevance_score: 0.003 },
    { index: 1, relevance_score: 0.002 },
  ],
  meta: { api_version: { version: "2" }, billed_units: { input_tokens: 1_000_000 } },
}
const v4Reply = { ...v5Reply, meta: { billed_units: { search_units: 1 } } }

const query = "Why did the chiller stop?"
const documents = [
  "The chiller tripped on low refrigerant pressure.",
  "Invoices are due within 30 days.",
  "Line three runs two shifts.",
]

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
          value: options.deployments ?? [v5Deployment, v4Deployment, chatDeployment],
        })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.reranking()", () => {
  test("posts Cohere's rerank request to the resource and prices Rerank v5 tokens", async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return Response.json(v5Reply, { headers: { "apim-request-id": "request-1" } })
    })
    const binding = provider.reranking("rerank-v5")
    expect(calls).toEqual([])
    expect(binding.definition).toEqual({
      kind: "reranking",
      providerId: "azure-ai-foundry",
      modelId: "rerank-v5",
      via: "Azure AI Foundry",
    })

    const model = await binding.resolve()
    const result = await model.rerank({ query, documents })

    expect(request?.url).toBe(rerankUrl)
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("application/json")
    // No top_n: Sixb needs a score for every document.
    expect(request?.body).toEqual({ model: "rerank-v5", query, documents })
    expect(result).toEqual({
      results: [
        { index: 0, score: 0.47 },
        { index: 2, score: 0.003 },
        { index: 1, score: 0.002 },
      ],
      usage: { inputTokens: 1_000_000, outputTokens: 0, raw: { input_tokens: 1_000_000 } },
      providerIds: { requestId: "request-1", responseId: "rerank-1" },
    })
    expect(model.definition.publisher).toEqual({ id: "cohere", name: "Cohere" })
    expect(model.metadata).toMatchObject({
      modelName: "Cohere-rerank-v5-fast",
      sku: "GlobalStandard",
    })
    // USD 0.02 per million input tokens.
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "20000000" },
    })
    expect(
      model.costEstimator?.estimateReservation?.({ inputTokens: 1_000_000, outputTokens: 0 })
    ).toEqual({ currency: "USD", amountNanos: "20000000" })
  })

  test("Rerank v4 bills searches, a unit with no rate card: its cost stays unknown", async () => {
    const { provider } = foundry(async () => Response.json(v4Reply))
    const model = await provider.reranking("rerank-v4").resolve()
    const result = await model.rerank({ query, documents })
    expect(result.usage).toEqual({ raw: { search_units: 1 } })
    expect(model.costEstimator).toBeUndefined()

    // Even a token card does not price a search bill.
    const carded = await provider
      .reranking("rerank-v4", { rateCard: { currency: "USD", input: "1", output: "0" } })
      .resolve()
    expect(carded.costEstimator?.estimate({ usage: result.usage! }).status).toBe("unpriceable")
  })

  test("prices only published models, versions and SKUs", async () => {
    const usage = { inputTokens: 100, outputTokens: 0 }
    const price = async (deployment: object) => {
      const { provider } = foundry(async () => Response.json(v5Reply), {
        deployments: [{ ...v5Deployment, ...deployment }],
      })
      const model = await provider.reranking("rerank-v5").resolve()
      return model.costEstimator?.estimate({ usage }).status
    }
    expect(await price({})).toBe("rated")
    expect(await price({ modelName: "Cohere-rerank-v5-pro" })).toBe("rated")
    expect(await price({ sku: { name: "DataZoneStandard" } })).toBe("rated")
    expect(await price({ modelVersion: "2" })).toBeUndefined()
    expect(await price({ sku: { name: "ProvisionedManaged" } })).toBeUndefined()

    const model = await foundry(async () => Response.json(v5Reply))
      .provider.reranking("rerank-v5")
      .resolve()
    const rate = (usage: object) => model.costEstimator?.estimate({ usage }).status
    // A zero count of another unit bills nothing; a reply without billed units is not free.
    expect(rate({ ...usage, raw: { input_tokens: 100, search_units: 0 } })).toBe("rated")
    expect(rate({ ...usage, raw: { input_tokens: 100, search_units: 1 } })).toBe("unpriceable")
    expect(model.costEstimator?.estimate({ usage: { outputTokens: 0 } })).toMatchObject({
      status: "unpriceable",
      reason: "missing-usage",
    })
  })

  test("keeps reranking and language deployments apart", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const notReranking = await provider
      .reranking("chat")
      .resolve()
      .catch((error: unknown) => error)
    expect(notReranking).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(notReranking)).toContain("runs future-chat, not a reranking model")
    // Discovery says Rerank v4 does chat completions; it does not.
    const asChat = await provider
      .chat("rerank-v4")
      .resolve()
      .catch((error: unknown) => error)
    expect(asChat).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(asChat)).toContain("Use foundry.reranking()")
    const listed = (await provider.catalog.list()).map((d) => d.modelId)
    expect(listed).toEqual(["chat"])

    const connected = foundry(async () => Response.json(v5Reply), {
      deployments: [{ ...v5Deployment, connectionName: "other-resource" }],
    }).provider
    const viaConnection = await connected
      .reranking("rerank-v5")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(viaConnection)).toContain("project connection")
    expect(() => provider.reranking(" rerank-v5")).toThrow("deploymentName")
    expect(() => provider.reranking("rerank-v5", { timeoutMs: 0 })).toThrow("timeoutMs")
  })

  test("an unresolved binding resolves once; no documents make no request", async () => {
    let posts = 0
    const { provider, calls } = foundry(async () => {
      posts++
      return Response.json(v5Reply)
    })
    const binding = provider.reranking("rerank-v5")
    expect(await binding.rerank({ query, documents: [] })).toEqual({ results: [] })
    await binding.rerank({ query, documents })
    await binding.rerank({ query, documents })
    expect(posts).toBe(2)
    expect(calls.filter((path) => path.endsWith("/deployments"))).toHaveLength(1)
  })
})

describe("reranking errors", () => {
  test("a rejection keeps Azure's message and code; throttling is not replayed", async () => {
    // Removal proof: drop "reranking" from ONE_SHOT in transport.ts; the 429 is posted thrice.
    let posts = 0
    const { provider } = foundry(
      async () => {
        posts++
        return posts === 1
          ? Response.json(
              { error: { code: "unknown_model", message: "Unknown model: gpt-5.4-nano" } },
              { status: 400 }
            )
          : new Response(null, { status: 429, headers: { "retry-after-ms": "250" } })
      },
      { maxRetries: 2 }
    )
    const model = await provider.reranking("rerank-v5").resolve()
    const rejected = await model.rerank({ query, documents }).catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(ModelProviderError)
    expect(rejected).toMatchObject({ status: 400, code: "unknown_model", retryable: false })
    const throttled = await model.rerank({ query, documents }).catch((e: unknown) => e)
    expect(throttled).toMatchObject({ status: 429, retryable: true, retryAfterMs: 250 })
    expect(posts).toBe(2)
  })

  test("a reply missing scores keeps its billed usage", async () => {
    const invalid = await foundry(async () => new Response("{"))
      .provider.reranking("rerank-v5")
      .resolve()
    expect(await invalid.rerank({ query, documents }).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_json",
    })

    for (const results of [
      v5Reply.results.slice(1),
      [...v5Reply.results.slice(1), { index: 2, relevance_score: 0.1 }],
      [{ index: 0, relevance_score: "high" }, ...v5Reply.results.slice(1)],
    ]) {
      const model = await foundry(async () => Response.json({ ...v5Reply, results }))
        .provider.reranking("rerank-v5")
        .resolve()
      const error = await model.rerank({ query, documents }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RerankingModelResponseError)
      expect(error).toMatchObject({ metadata: { usage: { inputTokens: 1_000_000 } } })
    }
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.reranking("rerank-v5", { timeoutMs: 5 }).resolve()
    expect(await timed.rerank({ query, documents }).catch((e: unknown) => e)).toMatchObject({
      name: "TimeoutError",
    })
    const controller = new AbortController()
    const model = await provider.reranking("rerank-v5").resolve()
    const pending = model
      .rerank({ query, documents, signal: controller.signal })
      .catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })
})

describe("in a project", () => {
  test("a vector query reranks its candidates with it and records the call", async () => {
    let sent: unknown
    const { provider } = foundry(async (_, init) => {
      sent = JSON.parse(String(init?.body))
      return Response.json({
        ...v5Reply,
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      })
    })
    const reranker = provider.reranking("rerank-v5")
    const embedding: EmbeddingModel = {
      providerId: "test",
      modelId: "embedding",
      definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
      embed: async ({ texts }) => ({ vectors: texts.map(() => [1, 0]) }),
    }
    const Note = defineObjectType({
      id: "Note",
      name: "Note",
      properties: [prop("id", "string", { primary: true, required: true }), prop("text", "string")],
      search: { vectors: { content: { source: ["text"], model: embedding } } },
    })
    const project = new SixbHost({
      id: "foundry-reranking",
      ontology: [Note],
      models: { embedding: [embedding], reranking: [reranker] },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(project)
    const notes = sixb.objects(Note)
    for (const [id, text] of [
      ["a", "Invoices are due within 30 days."],
      ["b", "The chiller tripped on low refrigerant pressure."],
    ] as const) {
      await notes.upsert({ properties: { id, text } })
      await notes.byId(id).vector("content").index()
    }

    const result = await notes
      .query()
      .vector("content", query, { k: 2 })
      .rerank({ model: reranker })
      .list()

    expect(result.objects.map((note) => note.primaryId)).toEqual(["b", "a"])
    expect(sent).toMatchObject({ model: "rerank-v5", query })
    expect(
      await project.storage.aiUsage!.getLatestForExecution({
        projectId: project.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({ modelKind: "reranking", requestedModelId: "rerank-v5" })
  })
})
