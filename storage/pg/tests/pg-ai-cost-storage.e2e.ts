import { expect, test } from "bun:test"
import type { AiCostStorage } from "@sixb/core/storage"
import {
  createTestAgentExecution,
  runAiCostStorageContractSuite,
  runAiModelCallGroupsContractSuite,
  seedAiCostStorageContractUsage,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAiModelCallGroupsContractSuite("PostgreSQL model-call groups", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: disposeTestStorage,
})

const bundles = new Map<AiCostStorage, PostgresStorage>()
test("PgAiCostStorage deserializes only the requested model-call page", async () => {
  const { storage } = await createTestStorage()
  try {
    await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
    const sql = (storage as unknown as { sql: PgStoreClient }).sql
    await sql`
      INSERT INTO ai_model_call_valuations (
        project_id, usage_record_id, status, provider_id, model_id,
        currency, amount_nanos, reason, details, rated_at
      ) VALUES (
        'cost-contract-project', 'usage_2', 'unpriceable', 'vercel', 'unpriced/model',
        NULL, NULL, 'missingRateCard', '{}'::jsonb, '2026-08-01T12:00:00.200Z'
      )
    `

    await expect(
      storage.aiCosts.listModelCalls({
        projectId: "cost-contract-project",
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-02T00:00:00.000Z"),
        limit: 1,
      })
    ).resolves.toMatchObject({
      total: 3,
      hasMore: true,
      items: [{ usage: { id: "usage_1" } }],
    })
  } finally {
    await disposeTestStorage(storage)
  }
})

test("PgAiCostStorage returns direct and child-agent attribution with each model-call page", async () => {
  const { storage } = await createTestStorage()
  try {
    const parentRunId = "parent_run_1"
    const childRunId = "child_run_1"
    await storage.agents.threads.create({
      id: "thread_1",
      projectId: "project_1",
      ownerPrincipal: { type: "user", id: "user_1" },
    })
    const parentExecutionId = await createTestAgentExecution(storage, {
      projectId: "project_1",
      runId: parentRunId,
      authority: "inherited",
      requesterGroupIds: ["users"],
    })
    await storage.agents.runs.create({
      id: parentRunId,
      projectId: "project_1",
      executionId: parentExecutionId,
      threadId: "thread_1",
      triggerMessageId: "message_1",
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    await storage.agents.runs.start({
      id: parentRunId,
      projectId: "project_1",
      execution: {
        token: "parent-token",
        queueLeaseExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
      },
    })
    const childExecutionId = await createTestAgentExecution(storage, {
      projectId: "project_1",
      actorId: "child",
      runId: childRunId,
      sourceExecutionId: parentExecutionId,
      authority: "inherited",
    })
    await storage.agents.runs.createSubagent({
      id: childRunId,
      projectId: "project_1",
      executionId: childExecutionId,
      parentRunId,
      parentExecutionToken: "parent-token",
      spawnKey: "research",
      spec: {
        model: { provider: "anthropic.messages", modelId: "claude-opus-4-8" },
        task: "Research the incident.",
        toolNames: [],
        maxSteps: 25,
      },
      thread: { id: `thread_${childRunId}`, create: true },
      trigger: {
        id: `task_${childRunId}`,
        parts: [{ type: "text", text: "Research the incident." }],
      },
      maxActiveChildren: 4,
    })
    for (const [id, executionId] of [
      ["usage_agent_1", parentExecutionId],
      ["usage_child_agent_1", childExecutionId],
    ] as const) {
      await storage.aiUsage.recordModelCall({
        id,
        projectId: "project_1",
        executionId,
        attempt: 1,
        callId: id,
        requesterGroupIds: ["users"],
        providerId: "anthropic.messages",
        requestedModelId: "claude-opus-4-8",
        responseId: id,
        usage: { inputTokens: 10, outputTokens: 5 },
        occurredAt: new Date("2026-09-01T12:00:00.000Z"),
      })
    }

    const page = await storage.aiCosts.listModelCalls({
      projectId: "project_1",
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-02T00:00:00.000Z"),
    })
    const attribution = (id: string) => page.items.find((item) => item.usage.id === id)?.attribution
    expect(attribution("usage_agent_1")).toMatchObject({
      kind: "agent",
      agentRunId: parentRunId,
      threadId: "thread_1",
    })
    expect(attribution("usage_child_agent_1")).toMatchObject({
      kind: "subagent",
      subagentRunId: childRunId,
      parentRunId,
    })
  } finally {
    await disposeTestStorage(storage)
  }
})

runAiCostStorageContractSuite("PgAiCostStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.aiCosts, storage)
    return storage.aiCosts
  },
  setup: async (costs) => {
    const storage = bundles.get(costs)
    if (!storage) throw new Error("Expected PostgreSQL storage bundle")
    await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
  },
  cleanup: async (costs) => {
    const storage = bundles.get(costs)
    if (!storage) return
    bundles.delete(costs)
    await disposeTestStorage(storage)
  },
})

// Removal proof: omit audio_duration_ms/model_kind from SQL reads, or the audio meter from cost validation.
test("round-trips audio duration, valuation and analytics without treating missing duration as zero", async () => {
  const { storage } = await createTestStorage()
  try {
    const projectId = "audio-accounting"
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      actorId: "assistant",
      runId: "audio",
    })
    const occurredAt = new Date("2026-08-01T12:00:00Z")
    for (const [id, duration] of [
      ["audio-known", 1250],
      ["audio-unknown", undefined],
    ] as const) {
      await storage.aiUsage.recordModelCall({
        id,
        projectId,
        executionId,
        attempt: 1,
        callId: id,
        requesterGroupIds: [],
        providerId: "test",
        requestedModelId: "transcribe",
        modelKind: "transcription",
        responseId: id,
        usage: duration === undefined ? {} : { audioDurationMs: duration },
        occurredAt,
      })
    }
    const component = {
      meter: "audio.input.milliseconds" as const,
      quantity: "1250",
      rateAmountNanosPerMillion: "100000000",
      chargeAmountNanos: "125000",
    }
    const cost = {
      projectId,
      usageRecordId: "audio-known",
      status: "rated" as const,
      billingIdentity: { providerId: "test", modelId: "transcribe" },
      pricingContext: {},
      priceSource: {
        sourceId: "test",
        sourceEntryId: "audio",
        sourceVersion: "1",
        observedAt: occurredAt,
      },
      money: { currency: "USD", amountNanos: "125000" },
      components: [component],
      ratedAt: occurredAt,
    }
    await storage.aiCosts.recordModelCallCost(cost)
    const range = { projectId, from: new Date("2026-08-01"), to: new Date("2026-08-02") }
    const page = await storage.aiCosts.listModelCalls(range)
    expect(page.items.find((item) => item.usage.id === "audio-known")).toMatchObject({
      usage: { modelKind: "transcription", usage: { audioDurationMs: 1250 } },
      cost: { money: cost.money, components: [component] },
    })
    const overview = await storage.aiCosts.queryProjectOverview({ ...range, bucket: "day" })
    expect(overview.totals.usage).toEqual({ audioDurationMs: 1250, reportingStatus: "partial" })
    expect(overview.totals.usageCoverage.fieldCallCounts.audioDurationMs).toBe(1)
    expect(overview.models[0]?.usage.audioDurationMs).toBe(1250)
    expect(overview.series[0]?.usage.audioDurationMs).toBe(1250)
    await expect(
      storage.aiCosts.recordModelCallCost({ ...cost, usageRecordId: "audio-unknown" })
    ).rejects.toThrow()
  } finally {
    await disposeTestStorage(storage)
  }
})
