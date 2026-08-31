import { describe, expect, test } from "bun:test"
import type { SixbHostView } from "@sixb/core"
import { InMemoryStorage } from "@sixb/core"
import { createTestAgentExecution } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerAiAccountingRoutes } from "../src/routes/ai-accounting"

const projectId = "ai-accounting-routes"

async function createApp() {
  const storage = new InMemoryStorage()
  await storage.agents.threads.create({
    id: "thread_1",
    projectId,
    agentId: "accounting-agent",
    ownerPrincipal: { type: "user", id: "user_1" },
  })
  const executionId = await createTestAgentExecution(storage, {
    projectId,
    agentId: "accounting-agent",
    runId: "run_1",
    executionId: "execution_1",
  })
  await storage.agents.runs.create({
    id: "run_1",
    projectId,
    executionId,
    threadId: "thread_1",
    agentId: "accounting-agent",
    triggerMessageId: "message_1",
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

describe("AI accounting routes", () => {
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
            agentId: "accounting-agent",
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
