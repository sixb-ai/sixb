import { expect, mock, test } from "bun:test"
import { defineObjectType, OntologyRegistry, prop, SixbHost } from "../src"
import { bindRequestExecution } from "../src/execution/request"
import type {
  EmbeddingModel,
  EmbeddingModelRequest,
  ModelCostEstimator,
  RerankingModel,
  RerankingModelRequest,
  RerankingModelResult,
} from "../src/models"
import { defineModelRateCard, estimateModelReservation, rateModelCall } from "../src/models"
import { executeObjectQuery } from "../src/objects/query"
import { rerankObjectCandidates } from "../src/objects/query/reranking-executor"
import { createSelectedObjectQueryAdmission } from "../src/objects/query/selected-read-admission"
import { validateObjectQueryWithAdmission } from "../src/objects/query/validate"
import { compileSelectedObjectReadScope } from "../src/storage"
import { createTestRuntimeDeps } from "./test-runtime-deps"

async function setup() {
  const deps = createTestRuntimeDeps()
  const controller = new AbortController()
  const rateCard = defineModelRateCard({
    currency: "USD",
    unit: "million-tokens",
    input: "1",
    output: "0",
  })
  const costEstimator: ModelCostEstimator = {
    estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard }),
    estimate: ({ usage }) => rateModelCall({ usage, rateCard }),
  }
  const embed = mock(async ({ texts }: EmbeddingModelRequest) => ({
    vectors: texts.map((text) => (text.includes("second") ? [0, 1] : [1, 0])),
    usage: { inputTokens: 3 },
  }))
  const embedding: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    costEstimator,
    embed,
  }
  const rerank = mock(
    async ({ documents }: RerankingModelRequest): Promise<RerankingModelResult> => ({
      results: documents.map((_, index) => ({ index, score: index + 1 })),
      usage: { inputTokens: 10 },
      reportedCost: { money: { currency: "USD", amountNanos: "50" } },
    })
  )
  const model: RerankingModel = {
    providerId: "test",
    modelId: "reranker",
    definition: { kind: "reranking", providerId: "test", modelId: "reranker" },
    costEstimator,
    rerank,
  }
  const Product = defineObjectType({
    id: "Product",
    name: "Product",
    properties: [
      prop("id", "string", {
        primary: true,
        required: true,
        query: { filterable: true, searchable: true },
      }),
      prop("title", "string"),
      prop("secret", "string"),
    ],
    search: { vectors: { content: { source: ["title"], model: embedding } } },
  })
  const host = new SixbHost({
    ...deps,
    id: "reranking",
    ontology: [Product],
    models: { embedding: [embedding], reranking: [model] },
  })
  const bind = () =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/search", { signal: controller.signal }),
      authorization: { type: "disabled" },
    })
  const seed = bind().objects(Product)
  for (const [id, title] of [
    ["a", "first"],
    ["b", "second"],
  ] as const) {
    await seed.upsert({ properties: { id, title, secret: "never send this" } })
    await seed.byId(id).vector("content").index()
  }
  embed.mockClear()
  const sixb = bind()
  const identity = { projectId: host.id, executionId: sixb.execution.id }
  const vector = () => sixb.objects(Product).query().vector("content", "find", { k: 2 })
  const query = () => vector().rerank({ model })
  return { ...deps, host, Product, model, embed, rerank, sixb, identity, vector, query, controller }
}

test("reranking is explicit, operates before the display limit and sends only profile sources", async () => {
  // Removal proof: bypass the pipeline branch in executeObjectQuery; ranking and call assertions fail.
  const f = await setup()
  expect((await f.vector().list()).objects.map((o) => o.primaryId)).toEqual(["a", "b"])
  expect(f.rerank).not.toHaveBeenCalled()
  const result = await f.query().limit(1).list()
  expect(result.objects.map((o) => [o.primaryId, o.score])).toEqual([["b", 2]])
  expect(result.total).toBe(2)
  expect(result.hasMore).toBe(true)
  expect(f.rerank.mock.calls[0]?.[0]).toMatchObject({
    query: "find",
    documents: ['[["title","first"]]', '[["title","second"]]'],
  })
  expect((await f.query().first())?.primaryId).toBe("b")
  expect(await f.query().list({ includeTotal: false })).not.toHaveProperty("total")
})

test("ties preserve candidate rank and aggregations do not pay for reranking", async () => {
  const f = await setup()
  f.rerank.mockResolvedValue({
    results: [
      { index: 1, score: 0.5 },
      { index: 0, score: 0.5 },
    ],
  })
  expect((await f.query().list()).objects.map((o) => o.primaryId)).toEqual(["a", "b"])
  f.rerank.mockClear()
  expect(await f.query().limit(1).count()).toBe(2)
  expect(await f.query().exists()).toBe(true)
  expect(f.rerank).not.toHaveBeenCalled()
})

test("empty candidates skip inference and unknown models fail before query embedding", async () => {
  const f = await setup()
  await f.sixb
    .objects(f.Product)
    .query()
    .where((o) => o.p.id.eq("absent"))
    .vector("content", "find", { k: 2 })
    .rerank({ model: f.model })
    .list()
  expect(f.rerank).not.toHaveBeenCalled()
  f.embed.mockClear()
  await expect(
    f
      .vector()
      .rerank({ model: { ...f.model, modelId: "unregistered" } })
      .list()
  ).rejects.toThrow("not configured")
  expect(f.embed).not.toHaveBeenCalled()
})

test("invalid compositions and excessive candidate counts fail before inference", async () => {
  const f = await setup()
  for (const query of [
    f.vector().limit(1).rerank({ model: f.model }),
    f.vector().rerank({ model: f.model }).rerank({ model: f.model }),
    f.sixb.objects(f.Product).query().rerank({ model: f.model }),
    f.sixb
      .objects(f.Product)
      .query()
      .vector("content", "find", { k: 101 })
      .rerank({ model: f.model }),
  ])
    await expect(query.list()).rejects.toThrow()
  expect(f.embed).not.toHaveBeenCalled()
  expect(f.rerank).not.toHaveBeenCalled()
})

test("oversized candidate text is rejected before contacting the reranker", async () => {
  // Removal proof: omit the byte-limit check in rerankObjectCandidates; this calls the model.
  const f = await setup()
  const vector = {
    kind: "vector" as const,
    input: { kind: "start" as const, objectTypeId: f.Product.id },
    profile: "content",
    source: ["title"],
    vector: "find",
    k: 2,
  }
  const candidate = await f.storage.objects.getByPrimaryId({
    projectId: f.host.id,
    objectTypeId: f.Product.id,
    primaryId: "a",
  })
  if (!candidate) throw new Error("Missing candidate")
  await expect(
    rerankObjectCandidates({
      query: f.query().ir,
      vector,
      model: f.model,
      candidates: [{ ...candidate, properties: { title: "a".repeat(1_048_576) } }],
    })
  ).rejects.toMatchObject({ code: "rerank_input_limit_exceeded" })
  expect(f.rerank).not.toHaveBeenCalled()
})

test("HTTP property projection applies only after reranking and retains total and scores", async () => {
  const f = await setup()
  const result = await executeObjectQuery(
    {
      projectId: f.host.id,
      query: {
        kind: "limit",
        limit: 1,
        input: { kind: "project", properties: ["id"], input: f.query().ir },
      },
    },
    {
      ontology: new OntologyRegistry({ sources: [f.Product] }),
      storage: f.storage.objects,
      embeddingModels: f.host.definitions.models?.embedding,
      rerankingModels: f.host.definitions.models?.reranking,
    }
  )
  expect(result.objects.map((row) => [row.primaryId, row.properties, row.score])).toEqual([
    ["b", { id: "b" }, 2],
  ])
  expect(result.total).toBe(2)
  expect(result.hasMore).toBe(true)
  expect(f.rerank.mock.calls[0]?.[0].documents).toEqual([
    '[["title","first"]]',
    '[["title","second"]]',
  ])
})

test("only authorized candidates reach the model and profile source grants are still required", async () => {
  const f = await setup()
  for (const propertyIds of [["id", "title"], ["id"]]) {
    const scope = compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: f.Product.id, primaryId: "b" },
          node: { objects: [{ objectTypeId: f.Product.id, propertyIds }], links: [] },
        },
      ],
    })
    const admission = createSelectedObjectQueryAdmission(scope)
    const query = f.query().ir
    if (!propertyIds.includes("title")) {
      expect(() =>
        validateObjectQueryWithAdmission(
          query,
          { ontology: new OntologyRegistry({ sources: [f.Product] }) },
          admission
        )
      ).toThrow()
      continue
    }
    const reader = f.storage.objects.createSelectedReadScope({
      projectId: f.host.id,
      scope,
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100000 },
    })
    const result = await executeObjectQuery(
      { projectId: f.host.id, query },
      {
        ontology: new OntologyRegistry({ sources: [f.Product] }),
        storage: reader,
        embeddingModels: f.host.definitions.models?.embedding,
        rerankingModels: f.host.definitions.models?.reranking,
      }
    )
    expect(result.objects.map((o) => o.primaryId)).toEqual(["b"])
    expect(f.rerank.mock.calls[0]?.[0].documents).toEqual(['[["title","second"]]'])
  }
})

test("embedding and reranking share execution attribution and accounting", async () => {
  // Removal proof: pass the raw reranking catalog from host; only the embedding usage remains.
  const f = await setup()
  await f.query().list()
  expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
    modelCallCount: 2,
    usage: { inputTokens: 13, outputTokens: 0, totalTokens: 13 },
  })
  const costs = await f.storage.aiCosts.listModelCalls({
    projectId: f.host.id,
    from: new Date("2000-01-01"),
    to: new Date("2100-01-01"),
  })
  const reranking = costs.items.find((call) => call.usage.requestedModelId === "reranker")
  expect(reranking?.cost).toMatchObject({
    status: "rated",
    money: { amountNanos: "50" },
  })
  // Removal proof: drop modelKind from recordReranking; the call is no longer distinguishable.
  expect(reranking?.usage.modelKind).toBe("reranking")
})

test("budget denial prevents reranking inference after candidate retrieval", async () => {
  const f = await setup()
  Object.assign(f.model, {
    costEstimator: {
      ...f.model.costEstimator,
      estimateReservation: () => ({ currency: "USD", amountNanos: "1000000" }),
    },
  })
  await f.storage.aiLimits.createPolicy({
    id: "money",
    projectId: f.host.id,
    subject: { type: "project" },
    limit: { meter: "cost.catalogEstimated", amount: { currency: "USD", amountNanos: "100000" } },
  })
  // Query embedding fits the limit; the reranker's reservation does not.
  await expect(f.query().list()).rejects.toMatchObject({ code: "ai.usage_limit_exceeded" })
  expect(f.embed).toHaveBeenCalledTimes(1)
  expect(f.rerank).not.toHaveBeenCalled()
})

test("malformed rankings remain billable and are never retried", async () => {
  // Removal proof: skip validateRerankingResults; duplicate/missing results would succeed.
  for (const results of [
    [],
    [
      { index: 0, score: 1 },
      { index: 0, score: 2 },
    ],
    [
      { index: 0, score: Number.NaN },
      { index: 1, score: 2 },
    ],
  ]) {
    const f = await setup()
    f.rerank.mockResolvedValue({ results, usage: { inputTokens: 7 } })
    await expect(f.query().list()).rejects.toMatchObject({ code: "invalid_reranking_response" })
    expect(f.rerank).toHaveBeenCalledTimes(1)
    expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
      modelCallCount: 2,
      usage: { inputTokens: 10 },
    })
  }
})

test("reported charges reconcile cost limits without inventing token usage", async () => {
  const f = await setup()
  await f.storage.aiLimits.createPolicy({
    id: "money",
    projectId: f.host.id,
    subject: { type: "project" },
    limit: { meter: "cost.catalogEstimated", amount: { currency: "USD", amountNanos: "100000" } },
  })
  f.rerank.mockResolvedValue({
    results: [
      { index: 0, score: 1 },
      { index: 1, score: 2 },
    ],
    reportedCost: { money: { currency: "USD", amountNanos: "50" } },
  })
  await f.query().list()
  await f.query().list()
  expect(f.rerank).toHaveBeenCalledTimes(2)
  expect(await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })).toMatchObject([
    {
      consumption: {
        actual: { amount: { amountNanos: "12100" } },
        reserved: { amount: { amountNanos: "0" } },
      },
    },
  ])
  const usage = await f.storage.aiUsage.summarizeExecution(f.identity)
  expect(usage.usage.totalTokens).toBeUndefined()
})

test("missing tariffs fail cost admission", async () => {
  const f = await setup()
  Object.assign(f.model, { costEstimator: undefined })
  await f.storage.aiLimits.createPolicy({
    id: "money",
    projectId: f.host.id,
    subject: { type: "project" },
    limit: { meter: "cost.catalogEstimated", amount: { currency: "USD", amountNanos: "100000" } },
  })
  await expect(f.query().list()).rejects.toMatchObject({ code: "ai.usage_limit_unavailable" })
  expect(f.rerank).not.toHaveBeenCalled()
})

test("token limits neither admit nor count reranking", async () => {
  // Removal proof: drop the aiLimitMeterApplies check in resolveAiLimitActual; the unmetered
  // rerank makes the token meter unavailable and the second query's embedding is refused.
  const f = await setup()
  await f.storage.aiLimits.createPolicy({
    id: "tokens",
    projectId: f.host.id,
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 1000 },
  })
  f.rerank.mockResolvedValue({
    results: [
      { index: 0, score: 1 },
      { index: 1, score: 2 },
    ],
  })
  await f.query().list()
  await f.query().list()
  expect(f.rerank).toHaveBeenCalledTimes(2)
  // Indexing (6) and two query embeddings (3 each) count; reranking does not.
  expect(await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })).toMatchObject([
    {
      accountingStatus: "complete",
      consumption: { actual: { amount: 12 }, reserved: { amount: 0 }, unknown: { amount: 0 } },
    },
  ])
})

test("cancellation after inference preserves its accounting", async () => {
  const f = await setup()
  f.rerank.mockImplementation(async () => {
    f.controller.abort()
    return {
      results: [
        { index: 0, score: 1 },
        { index: 1, score: 2 },
      ],
      usage: { inputTokens: 7 },
    }
  })
  await expect(f.query().list()).rejects.toThrow()
  expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
    modelCallCount: 2,
    usage: { inputTokens: 10 },
  })
})

test("accounting preserves all actual provider token meters", async () => {
  // Removal proof: force outputTokens to zero in recordReranking; this loses reported usage.
  const f = await setup()
  f.rerank.mockResolvedValue({
    results: [
      { index: 0, score: 1 },
      { index: 1, score: 2 },
    ],
    usage: { inputTokens: 7, outputTokens: 2 },
  })
  await f.query().list()
  expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
    modelCallCount: 2,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  })
})

test("unknown provider usage is retained without fabricating tokens or retrying inference", async () => {
  const f = await setup()
  f.rerank.mockRejectedValue(new Error("connection lost"))
  await expect(f.query().list()).rejects.toThrow("connection lost")
  expect(f.rerank).toHaveBeenCalledTimes(1)
  const calls = await f.storage.aiCosts.listModelCalls({
    projectId: f.host.id,
    executionId: f.identity.executionId,
    from: new Date("2000-01-01"),
    to: new Date("2100-01-01"),
  })
  const usage = calls.items.find((call) => call.usage.requestedModelId === "reranker")?.usage
  expect(usage?.requestedModelId).toBe("reranker")
  expect(usage?.usage.inputTokens).toBeUndefined()
  expect(usage?.usage.totalTokens).toBeUndefined()
})
