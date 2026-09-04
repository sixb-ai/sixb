import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage, type ReadonlyJsonValue } from "@sixb/core"
import type { AgentAiUsageRecordRequestedQueueJob } from "@sixb/core/queues"
import { AiUsageStorageError, type RecordAiModelCallInput } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import {
  agentAiUsageRecoveryJobId,
  enqueueAiModelCallRecovery,
  isPermanentAiUsageRecoveryError,
  recordRecoveredAiModelCall,
} from "../src/model-call-recovery"

const projectId = "project_1"
const executionId = "test_agent_execution:run_1"

function modelCall(): RecordAiModelCallInput {
  return {
    id: "usage_1",
    projectId,
    executionId,
    attempt: 2,
    callId: "call_1",
    requesterGroupIds: ["support", "engineering"],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5",
    responseId: "response_1",
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 12,
      cacheReadInputTokens: 0,
    },
    rawUsage: { input_tokens: 12, output_tokens: 8 },
    occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    recordedAt: new Date("2026-07-01T12:00:01.000Z"),
  }
}

describe("AI usage recovery", () => {
  test("serializes one stable job and replays it idempotently", async () => {
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })

    const record = modelCall()
    await enqueueAiModelCallRecovery(queues.agents, record)
    await enqueueAiModelCallRecovery(queues.agents, record)

    const [claimed] = await queues.agents.claim({
      projectId,
      workerId: "test-worker",
      limit: 2,
    })
    expect(claimed?.job.id).toBe(agentAiUsageRecoveryJobId(record.id))
    expect(claimed?.job.type).toBe("agent.ai-usage.record.requested")
    if (claimed?.job.type !== "agent.ai-usage.record.requested") {
      throw new Error("Expected an AI usage recovery job.")
    }
    const jsonRecord: ReadonlyJsonValue = claimed.job.payload.record
    expect(jsonRecord).toBeDefined()
    expect(claimed.job.payload.record).toMatchObject({
      id: "usage_1",
      executionId,
      occurredAt: "2026-07-01T12:00:00.000Z",
    })
    expect(claimed.job.payload.record).not.toHaveProperty("projectId")
    expect(claimed.job.payload.record).not.toHaveProperty("recordedAt")
    expect(claimed.job.payload.record.usage).toMatchObject({ cacheReadInputTokens: 0 })

    await expect(recordRecoveredAiModelCall(storage, claimed.job)).resolves.toMatchObject({
      created: true,
    })
    await expect(recordRecoveredAiModelCall(storage, claimed.job)).resolves.toMatchObject({
      created: false,
    })
    await expect(
      storage.aiUsage.summarizeExecution({ projectId, executionId })
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
  })

  test("recovers pricing context and local valuation atomically for current jobs", async () => {
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage: modelCall(),
      pricingContext: { serviceTier: "standard" },
      ratedAt: new Date("2026-07-01T12:00:01.000Z"),
    })
    const [claimed] = await queues.agents.claim({
      projectId,
      workerId: "test-worker",
      limit: 1,
    })
    if (claimed?.job.type !== "agent.ai-usage.record.requested") {
      throw new Error("Expected an AI usage recovery job.")
    }
    expect(claimed.job.payload.accounting).toEqual({
      pricingContext: { serviceTier: "standard" },
      ratedAt: "2026-07-01T12:00:01.000Z",
    })

    await expect(recordRecoveredAiModelCall(storage, claimed.job)).resolves.toMatchObject({
      created: true,
    })
    await expect(
      storage.aiCosts.listModelCalls({
        projectId,
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-07-02T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      items: [
        {
          cost: {
            status: "rated",
            billingIdentity: { providerId: "vercel", modelId: "openai/gpt-5" },
            pricingContext: { serviceTier: "standard" },
          },
        },
      ],
    })
  })

  test("durable accounting recovery reconciles the original reservation", async () => {
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })
    await storage.aiLimits.createPolicy({
      id: "project_tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1_000 },
    })
    await storage.aiLimits.reserveModelCall({
      projectId,
      executionId,
      attempt: 2,
      callId: "call_1",
      subjects: [{ type: "project" }],
      estimates: [{ meter: "tokens.total", amount: 100 }],
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage: modelCall(),
      pricingContext: {},
      ratedAt: new Date("2026-07-01T12:00:01.000Z"),
      reconcileLimitReservation: true,
    })
    const [claimed] = await queues.agents.claim({
      projectId,
      workerId: "test-worker",
      limit: 1,
    })
    if (claimed?.job.type !== "agent.ai-usage.record.requested") {
      throw new Error("Expected an AI usage recovery job.")
    }
    expect(claimed.job.payload.accounting?.reconcileLimitReservation).toBe(true)

    await recordRecoveredAiModelCall(storage, claimed.job)
    await expect(
      storage.aiLimits.listPolicyStatuses({
        projectId,
        at: new Date("2026-07-15T00:00:00.000Z"),
      })
    ).resolves.toMatchObject([
      {
        consumption: {
          actual: { amount: 20 },
          reserved: { amount: 0 },
          unknown: { amount: 0 },
        },
      },
    ])
  })

  test("keeps the estimate as unknown when recovered usage cannot be measured", async () => {
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })
    await storage.aiLimits.createPolicy({
      id: "project_tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1_000 },
    })
    await storage.aiLimits.reserveModelCall({
      projectId,
      executionId,
      attempt: 2,
      callId: "call_missing",
      subjects: [{ type: "project" }],
      estimates: [{ meter: "tokens.total", amount: 100 }],
      reservedAt: new Date("2026-07-01T11:59:59.000Z"),
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage: {
        ...modelCall(),
        id: "usage_missing",
        callId: "call_missing",
        usage: {},
      },
      pricingContext: {},
      ratedAt: new Date("2026-07-01T12:00:01.000Z"),
      reconcileLimitReservation: true,
    })
    const [claimed] = await queues.agents.claim({
      projectId,
      workerId: "test-worker",
      limit: 1,
    })
    if (claimed?.job.type !== "agent.ai-usage.record.requested") {
      throw new Error("Expected an AI usage recovery job.")
    }

    await expect(recordRecoveredAiModelCall(storage, claimed.job)).resolves.toMatchObject({
      created: true,
    })
    await expect(
      storage.aiLimits.listPolicyStatuses({
        projectId,
        at: new Date("2026-07-15T00:00:00.000Z"),
      })
    ).resolves.toMatchObject([
      {
        accountingStatus: "unavailable",
        consumption: {
          actual: { amount: 0 },
          reserved: { amount: 0 },
          unknown: { amount: 100 },
        },
      },
    ])
  })

  test("rejects malformed jobs instead of retrying them forever", async () => {
    const record = modelCall()
    const job: AgentAiUsageRecordRequestedQueueJob = {
      id: agentAiUsageRecoveryJobId(record.id),
      projectId,
      createdAt: "2026-07-01T12:00:00.000Z",
      availableAt: "2026-07-01T12:00:00.000Z",
      attempt: 1,
      type: "agent.ai-usage.record.requested",
      payload: {
        record: {
          ...record,
          occurredAt: "not-a-date",
        },
      },
    }

    const storage = new InMemoryStorage()
    const invalidJobError = await recordRecoveredAiModelCall(storage, job).catch(
      (error: unknown) => error
    )
    expect(invalidJobError).toMatchObject({
      name: "InvalidAiUsageRecoveryJobError",
      message:
        "[SixbAgentWorker] AI usage recovery job 'agt_usage_job_usage_1' has an invalid occurredAt timestamp.",
    })
    expect(isPermanentAiUsageRecoveryError(invalidJobError)).toBe(true)
    expect(isPermanentAiUsageRecoveryError(new TypeError("invalid"))).toBe(true)
    expect(
      isPermanentAiUsageRecoveryError(
        new AiUsageStorageError("missing_execution", "missing execution")
      )
    ).toBe(true)
    expect(isPermanentAiUsageRecoveryError(new Error("storage unavailable"))).toBe(false)
  })
})
