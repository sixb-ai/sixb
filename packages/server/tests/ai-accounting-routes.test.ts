import { describe, expect, test } from "bun:test"
import type { SixbHostView } from "@sixb/core"
import {
  emptyGrantIndex,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestAgentExecution, createTestSixb } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerAiAccountingRoutes } from "../src/routes/ai-accounting"

const projectId = "ai-accounting-routes"

async function createApp(reportCost = false) {
  const storage = new InMemoryStorage()
  await storage.agents.threads.create({
    id: "thread_1",
    projectId,
    ownerPrincipal: { type: "user", id: "user_1" },
  })
  const executionId = await createTestAgentExecution(storage, {
    projectId,
    runId: "run_1",
    executionId: "execution_1",
  })
  await storage.agents.runs.create({
    id: "run_1",
    projectId,
    executionId,
    threadId: "thread_1",
    triggerMessageId: "message_1",
    spec: { model: { provider: "test", modelId: "test-model" } },
    requesterGroupIds: [],
  })
  await storage.transaction(async (tx) => {
    const usage = await tx.aiUsage!.recordModelCall({
      id: "usage_1",
      projectId,
      executionId: "execution_1",
      attempt: 1,
      callId: "call_1",
      requesterGroupIds: [],
      providerId: "openai",
      requestedModelId: "gpt-5",
      responseId: "response_1",
      usage: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 },
      occurredAt: new Date("2026-09-10T12:30:00.000Z"),
      recordedAt: new Date("2026-09-10T12:30:00.100Z"),
    })
    if (reportCost) {
      await tx.aiCosts!.recordModelCallCost({
        projectId,
        usageRecordId: usage.record.id,
        status: "reported",
        billingIdentity: { providerId: "openai", modelId: "gpt-5" },
        pricingContext: { serviceTier: "priority" },
        reportSource: { providerId: "openai", responseId: "cost_response_1" },
        money: { currency: "USD", amountNanos: "530200" },
        ratedAt: new Date("2026-09-10T12:30:00.200Z"),
      })
      return
    }
    await tx.aiCosts!.recordModelCallCost({
      projectId,
      usageRecordId: usage.record.id,
      status: "unpriceable",
      billingIdentity: { providerId: "openai", modelId: "gpt-5" },
      pricingContext: { serviceTier: "priority" },
      priceSource: {
        sourceId: "test-catalog",
        sourceEntryId: "openai/gpt-5",
        sourceVersion: "test-catalog-v1",
        sourceUrl: "https://example.test/ai-pricing.json",
        observedAt: new Date("2026-09-10T12:00:00.000Z"),
      },
      reason: "unsupportedPricingDimension",
      ratedAt: new Date("2026-09-10T12:30:00.200Z"),
    })
  })
  const host = {
    id: projectId,
    storage: { aiCosts: storage.aiCosts },
  } as unknown as SixbHostView
  return registerAiAccountingRoutes(new Elysia(), host)
}

async function createSubagentApp(viewer?: { id: string; canRun: boolean }) {
  const storage = new InMemoryStorage()
  const parentRunId = "parent_run_1"
  const childRunId = "child_run_1"
  await storage.agents.threads.create({
    id: "thread_1",
    projectId,
    ownerPrincipal: { type: "user", id: "user_1" },
    title: "Private research",
  })
  const parentExecutionId = await createTestAgentExecution(storage, {
    projectId,
    runId: parentRunId,
    authority: "inherited",
  })
  await storage.agents.runs.create({
    id: parentRunId,
    projectId,
    executionId: parentExecutionId,
    threadId: "thread_1",
    triggerMessageId: "message_1",
    spec: { model: { provider: "test", modelId: "test-model" } },
    requesterGroupIds: [],
  })
  await storage.agents.runs.start({
    id: parentRunId,
    projectId,
    execution: {
      token: "parent-token",
      queueLeaseExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
    },
  })
  const childExecutionId = await createTestAgentExecution(storage, {
    projectId,
    actorId: "child",
    runId: childRunId,
    sourceExecutionId: parentExecutionId,
    authority: "inherited",
  })
  await storage.agents.runs.createSubagent({
    id: childRunId,
    projectId,
    executionId: childExecutionId,
    parentRunId,
    parentExecutionToken: "parent-token",
    spawnKey: "research",
    spec: {
      model: { provider: "openai", modelId: "gpt-5" },
      task: "Research the issue.",
      toolNames: [],
      maxSteps: 25,
    },
    maxActiveChildren: 4,
  })
  await storage.aiUsage.recordModelCall({
    id: "usage_child_1",
    projectId,
    executionId: childExecutionId,
    attempt: 1,
    callId: "call_1",
    requesterGroupIds: [],
    providerId: "openai",
    requestedModelId: "gpt-5",
    responseId: "response_1",
    usage: { inputTokens: 10, outputTokens: 5 },
    occurredAt: new Date("2026-09-10T12:30:00.000Z"),
  })
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
  })
  const app = new Elysia()
  app.derive(() => ({
    sixb: viewer
      ? createTestSixb(host, {
          authorization: {
            principal: { type: "user", id: viewer.id },
            groupIds: [],
            roleIds: [],
            grants: { ...emptyGrantIndex(), "run:agent": viewer.canRun },
          },
        })
      : null,
  }))
  return registerAiAccountingRoutes(app, host)
}

describe("AI accounting routes", () => {
  test.each([
    { id: "user_1", canRun: true, visible: true },
    { id: "user_1", canRun: false, visible: false },
    { id: "someone_else", canRun: true, visible: false },
  ])("groups child-only matches and protects conversation labels: %j", async (viewer) => {
    // Bypassing the scoped thread lookup exposes Private research / research to other users.
    const app = await createSubagentApp(viewer)
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-call-groups?" +
          new URLSearchParams({
            from: "2026-09-10T12:00:00.000Z",
            to: "2026-09-10T14:00:00.000Z",
            modelId: "gpt-5",
            limit: "1",
          })
      )
    )
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      total: 1,
      hasMore: false,
      items: [
        {
          attribution: { kind: "agent", agentRunId: "parent_run_1", threadId: "thread_1" },
          firstCallAt: "2026-09-10T12:30:00.000Z",
          modelCallCount: 1,
          totalTokens: 15,
          canOpenThread: viewer.visible,
          executions: [
            { attribution: { kind: "subagent", subagentRunId: "child_run_1" }, modelCallCount: 1 },
          ],
        },
      ],
    })
    expect(result.items[0].label).toBe(viewer.visible ? "Private research" : undefined)
    expect(result.items[0].executions[0].label).toBe(viewer.visible ? "research" : undefined)
  })

  test("validates group pagination and valuation filters", async () => {
    const app = await createSubagentApp()
    for (const extra of ["limit=201", "offset=-1", "valuationStatus=invalid"]) {
      const response = await app.handle(
        new Request(
          `http://localhost/api/ai/model-call-groups?from=2026-09-10T12:00:00Z&to=2026-09-10T14:00:00Z&${extra}`
        )
      )
      expect([400, 422]).toContain(response.status)
    }
  })

  test("serializes reported cost provenance and includes it in pricing coverage", async () => {
    const app = await createApp(true)
    const query = new URLSearchParams({
      from: "2026-09-10T12:00:00.000Z",
      to: "2026-09-10T14:00:00.000Z",
    })
    const response = await app.handle(
      new Request(`http://localhost/api/ai/model-calls?${query}&valuationStatus=reported`)
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [
        {
          valuationStatus: "reported",
          cost: {
            status: "reported",
            money: { currency: "USD", amountNanos: "530200" },
            reportSource: { providerId: "openai", responseId: "cost_response_1" },
            ratedAt: "2026-09-10T12:30:00.200Z",
          },
        },
      ],
    })
    const overview = await app.handle(
      new Request(`http://localhost/api/ai/accounting/overview?${query}&bucket=hour`)
    )
    expect(overview.status).toBe(200)
    expect(await overview.json()).toMatchObject({
      totals: {
        costs: {
          amounts: [{ currency: "USD", amountNanos: "530200" }],
          reportedCallCount: 1,
          ratedCallCount: 0,
          unpriceableCallCount: 0,
          unvaluedCallCount: 0,
        },
      },
    })
  })
  test("returns chart-ready project usage with honest pricing coverage", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/accounting/overview?" +
          new URLSearchParams({
            from: "2026-09-10T12:00:00.000Z",
            to: "2026-09-10T14:00:00.000Z",
            bucket: "hour",
          })
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      range: {
        from: "2026-09-10T12:00:00.000Z",
        to: "2026-09-10T14:00:00.000Z",
      },
      totals: {
        modelCallCount: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningOutputTokens: 2,
          reportingStatus: "complete",
        },
        costs: {
          amounts: [],
          ratedCallCount: 0,
          unpriceableCallCount: 1,
          unvaluedCallCount: 0,
        },
      },
      series: [
        { start: "2026-09-10T12:00:00.000Z", modelCallCount: 1 },
        { start: "2026-09-10T13:00:00.000Z", modelCallCount: 0 },
      ],
      models: [{ providerId: "openai", modelId: "gpt-5", modelCallCount: 1 }],
    })
  })

  test("lists model calls with pricing context and unpriceable diagnostics", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-calls?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            valuationStatus: "unpriceable",
          })
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      hasMore: false,
      items: [
        {
          usage: {
            id: "usage_1",
            executionId: "execution_1",
            providerId: "openai",
            requestedModelId: "gpt-5",
          },
          attribution: {
            kind: "agent",
            agentRunId: "run_1",
            threadId: "thread_1",
          },
          cost: {
            status: "unpriceable",
            pricingContext: { serviceTier: "priority" },
            reason: "unsupportedPricingDimension",
          },
          valuationStatus: "unpriceable",
        },
      ],
    })
  })

  test("serializes child-agent attribution", async () => {
    const app = await createSubagentApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-calls?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
          })
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [
        {
          attribution: {
            kind: "subagent",
            subagentRunId: "child_run_1",
            parentRunId: "parent_run_1",
          },
        },
      ],
    })
  })

  test("rejects malformed model-call pagination integers", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-calls?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            limit: "25garbage",
          })
      )
    )
    expect(response.status).toBe(422)
  })

  test("reports unavailable AI cost storage explicitly", async () => {
    const host = { id: projectId, storage: {} } as unknown as SixbHostView
    const app = registerAiAccountingRoutes(new Elysia(), host)
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/accounting/overview?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            bucket: "day",
          })
      )
    )
    expect(response.status).toBe(501)
  })
})
