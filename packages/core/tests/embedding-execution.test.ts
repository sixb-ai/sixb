import { describe, expect, mock, test } from "bun:test"
import { defineObjectType, prop, SixbHost } from "../src"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { bindRequestExecution } from "../src/execution/request"
import {
  type EmbeddingModel,
  EmbeddingModelResponseError,
  type EmbeddingModelResult,
} from "../src/models"
import { createTestActionExecution } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const deps = createTestRuntimeDeps()
  const controller = new AbortController()
  const embed = mock(
    async (): Promise<EmbeddingModelResult> => ({
      vectors: [[1, 0]],
      usage: { inputTokens: 12 },
      providerIds: { requestId: "provider-request" },
      reportedCost: { money: { currency: "USD", amountNanos: "120" } },
    })
  )
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    embed,
  }
  const Product = defineObjectType({
    id: "Product",
    name: "Product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("description", "string"),
    ],
    search: { vectors: { content: { source: ["description"], model } } },
  })
  const host = new SixbHost({
    id: "embeddings",
    ontology: [Product],
    models: { embedding: [model] },
    ...deps,
  })
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/search", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  const objects = sixb.objects(Product)
  const identity = { projectId: host.id, executionId: sixb.execution.id }
  const search = () => objects.query().vector("content", "search text", { k: 1 }).list()
  return { ...deps, Product, embed, model, host, sixb, objects, identity, search, controller }
}

describe("embedding execution accounting", () => {
  test("indexing and text search share execution attribution and atomic accounting", async () => {
    // Removal proof: give the host its raw embedding catalog; both usage records disappear.
    const f = setup()
    await f.objects.upsert({ properties: { id: "p", description: "description" } })
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1000 },
    })
    await f.objects.byId("p").vector("content").index()
    await f.search()
    expect(f.embed).toHaveBeenCalledTimes(2)
    expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
      modelCallCount: 2,
      usage: { inputTokens: 24, outputTokens: 0, totalTokens: 24 },
    })
    expect(await f.storage.aiUsage.getLatestForExecution(f.identity)).toMatchObject({
      ...f.identity,
      attempt: 1,
      providerIds: { requestId: "provider-request" },
    })
    const costs = await f.storage.aiCosts.listModelCalls({
      projectId: f.host.id,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    })
    expect(costs.items).toHaveLength(2)
    expect(costs.items[0]?.cost).toMatchObject({ status: "rated", money: { amountNanos: "120" } })
    expect(await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })).toMatchObject([
      { consumption: { actual: { amount: 24 }, reserved: { amount: 0 } } },
    ])
  })

  test("worker deliveries retain admitted groups and their actual attempt", async () => {
    const f = setup()
    const groups = ["admitted"]
    const executionId = await createTestActionExecution(f.storage.executions, {
      projectId: f.host.id,
      actionId: "search",
      runId: "action",
      requesterGroupIds: groups,
    })
    const execution = await f.storage.executions.getById({ projectId: f.host.id, id: executionId })
    if (!execution) throw new Error("Missing test execution")
    groups.push("later")
    const sixb = bindDurablePrimitiveExecution(f.host, {
      execution,
      primitive: { kind: "action", id: "search", runId: "action" },
      modelExecution: { attempt: 3, signal: new AbortController().signal },
    }).sixb
    await sixb.objects(f.Product).query().vector("content", "find", { k: 1 }).list()
    expect(
      await f.storage.aiUsage.getLatestForExecution({ projectId: f.host.id, executionId })
    ).toMatchObject({
      executionId,
      attempt: 3,
      requesterGroupIds: ["admitted"],
    })
  })

  test("concurrent requests cannot spend the same reserved capacity", async () => {
    const f = setup()
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 3 },
    })
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.embed.mockImplementation(async () => {
      entered()
      await pending
      return { vectors: [[1, 0]], usage: { inputTokens: 3 } }
    })
    const first = f.search()
    await started
    try {
      await expect(f.search()).rejects.toMatchObject({ code: "ai.usage_limit_exceeded" })
      expect(f.embed).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await first
    }
    expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
      modelCallCount: 1,
    })
  })

  test("denies a token budget before contacting the provider", async () => {
    const f = setup()
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1 },
    })
    await expect(f.search()).rejects.toMatchObject({ code: "ai.usage_limit_exceeded" })
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("fails closed for a monetary budget without a reservation price", async () => {
    const f = setup()
    await f.storage.aiLimits.createPolicy({
      id: "cost",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "cost.catalogEstimated", amount: { currency: "USD", amountNanos: "1000" } },
    })
    await expect(f.search()).rejects.toMatchObject({ code: "ai.usage_limit_unavailable" })
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("preserves unknown input usage and price instead of inventing zero", async () => {
    const f = setup()
    f.embed.mockResolvedValue({ vectors: [[1, 0]] })
    await f.search()
    const row = await f.storage.aiUsage.getLatestForExecution(f.identity)
    expect(row?.usage.inputTokens).toBeUndefined()
    expect(row?.usage.totalTokens).toBeUndefined()
    const costs = await f.storage.aiCosts.listModelCalls({
      projectId: f.host.id,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    })
    expect(costs.items[0]?.cost).toMatchObject({ status: "unpriceable" })
  })

  test("accounts for malformed vectors and billable provider response errors", async () => {
    for (const providerRejects of [false, true]) {
      const f = setup()
      f.embed.mockImplementation(async () => {
        const metadata = { usage: { inputTokens: 9 } }
        if (providerRejects)
          throw new EmbeddingModelResponseError("bad vector", "test", "embedding", metadata)
        return { ...metadata, vectors: [[0, 0]] }
      })
      await expect(f.search()).rejects.toThrow()
      expect(f.embed).toHaveBeenCalledTimes(1)
      expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
        modelCallCount: 1,
        usage: { inputTokens: 9 },
      })
    }
  })

  test("records a completed call even when the object changed during inference", async () => {
    const f = setup()
    await f.objects.upsert({ properties: { id: "p", description: "before" } })
    f.embed.mockImplementation(async () => {
      await f.objects.upsert({ properties: { id: "p", description: "after" } })
      return { vectors: [[1, 0]], usage: { inputTokens: 12 } }
    })
    await expect(f.objects.byId("p").vector("content").index()).rejects.toThrow()
    expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
      modelCallCount: 1,
    })
  })

  test("concurrent searches keep distinct call identities in one execution", async () => {
    const f = setup()
    await Promise.all([f.search(), f.search()])
    expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
      modelCallCount: 2,
    })
  })

  test("cancellation before admission avoids inference; after a response it preserves usage", async () => {
    const before = setup()
    before.controller.abort()
    await expect(before.search()).rejects.toThrow()
    expect(before.embed).not.toHaveBeenCalled()
    const after = setup()
    after.embed.mockImplementation(async () => {
      after.controller.abort()
      return { vectors: [[1, 0]], usage: { inputTokens: 7 } }
    })
    await expect(after.search()).rejects.toThrow()
    expect(await after.storage.aiUsage.summarizeExecution(after.identity)).toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 7 },
    })
  })

  test("an ambiguous failure keeps its reservation and never retries inference", async () => {
    const f = setup()
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 100 },
    })
    f.embed.mockRejectedValue(new Error("connection lost"))
    await expect(f.search()).rejects.toThrow("connection lost")
    expect(f.embed).toHaveBeenCalledTimes(1)
    const statuses = await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })
    const unknown = statuses[0]?.consumption.unknown
    expect(unknown?.meter === "tokens.total" && unknown.amount > 0).toBe(true)
  })
})

test("resolved representation drift fails before provider inference or budget admission", async () => {
  // Removal proof: compare only route/dimensions in executeEmbedding; inference is called.
  const f = setup()
  f.model.resolve = async () => ({
    ...f.model,
    definition: {
      ...f.model.definition,
      representation: { name: "different-model", version: "2" },
    },
  })
  await expect(f.search()).rejects.toThrow("identity does not match")
  expect(f.embed).not.toHaveBeenCalled()
  expect(await f.storage.aiUsage.summarizeExecution(f.identity)).toMatchObject({
    modelCallCount: 0,
  })
})
