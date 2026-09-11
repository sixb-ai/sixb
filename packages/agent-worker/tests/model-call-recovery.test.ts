import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage, type ReadonlyJsonValue } from "@sixb/core"
import {
  isPermanentAiUsageRecoveryError,
  type RecoverAiModelCallInput,
  recordRecoveredAiModelCall,
} from "@sixb/core/internal/model-execution"
import { rateModelCall } from "@sixb/core/models"
import type { AgentAiUsageRecordRequestedQueueJob } from "@sixb/core/queues"
import { AiUsageStorageError, type RecordAiModelCallInput } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { agentAiUsageRecoveryJobId, enqueueAiModelCallRecovery } from "../src/model-call-recovery"

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
    requestedReasoning: { budgetTokens: 4_096 },
    responseId: "response_1",
    providerIds: { requestId: "req-1", generationId: "gen_1" },
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

function accounting(usage: RecordAiModelCallInput): RecoverAiModelCallInput {
  return {
    usage,
    cost: { status: "unpriceable", reason: "missing-rate-card" },
    ratedAt: usage.occurredAt,
  }
}

describe("AI usage recovery", () => {
  test.each([
    undefined,
    {},
    { routedProviderId: "openai", routedModelId: "gpt-5" },
  ])("preserves usage from legacy recovery jobs (%j)", async (pricingContext) => {
    // Regression proof: remove the legacy pricingContext branch in accountingFromQueuePayload.
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      actorId: "assistant",
      runId: "run_1",
      executionId,
    })
    const record = modelCall()
    await enqueueAiModelCallRecovery(queues.agents, accounting(record))
    const [claim] = await queues.agents.claim({ projectId, workerId: "test", limit: 1 })
    if (claim?.job.type !== "agent.ai-usage.record.requested")
      throw new Error("Expected recovery job")
    // Model the JSON boundary of a job persisted before completed-call costs were captured.
    const legacyJob: AgentAiUsageRecordRequestedQueueJob = JSON.parse(
      JSON.stringify({
        ...claim.job,
        payload: {
          ...claim.job.payload,
          accounting:
            pricingContext === undefined
              ? undefined
              : { pricingContext, ratedAt: record.recordedAt?.toISOString() },
        },
      })
    )
    await expect(recordRecoveredAiModelCall(storage, legacyJob)).resolves.toMatchObject({
      created: true,
    })
    await expect(recordRecoveredAiModelCall(storage, legacyJob)).resolves.toMatchObject({
      created: false,
    })
    await expect(
      storage.aiUsage.summarizeExecution({ projectId, executionId })
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
    const page = await storage.aiCosts.listModelCalls({
      projectId,
      from: new Date("2026-07-01"),
      to: new Date("2026-07-02"),
    })
    expect(page.total).toBe(1)
    expect(page.items[0]?.cost).toBeUndefined()
  })

  test("retains the estimate and inline cost through queue serialization and replay", async () => {
    // Regression proof: drop estimate from either recovery codec; only the report will survive.
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      actorId: "assistant",
      runId: "run_1",
      executionId,
    })
    const usage = modelCall()
    const estimate = rateModelCall({
      usage: usage.usage,
      rateCard: {
        currency: "USD",
        unit: "million-tokens",
        input: "1",
        output: "2",
        cacheReadInput: "0",
      },
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage,
      estimate,
      cost: { status: "reported", money: { currency: "USD", amountNanos: "25000" } },
      ratedAt: usage.occurredAt,
    })
    const [claim] = await queues.agents.claim({ projectId, workerId: "test", limit: 1 })
    if (claim?.job.type !== "agent.ai-usage.record.requested")
      throw new Error("Expected recovery job")
    await recordRecoveredAiModelCall(storage, claim.job)
    await recordRecoveredAiModelCall(storage, claim.job)
    const page = await storage.aiCosts.listModelCalls({
      projectId,
      from: new Date("2026-07-01"),
      to: new Date("2026-07-02"),
    })
    expect(page.total).toBe(1)
    expect(page.items[0]?.cost).toMatchObject({
      money: { amountNanos: "25000" },
      priceSource: { sourceId: "provider-reported" },
      estimate: { status: "rated", money: { amountNanos: "28000" } },
    })
    expect(
      (await storage.aiCosts.summarizeExecutions({ projectId, executionIds: [executionId] }))[0]
        ?.amounts
    ).toEqual([{ currency: "USD", amountNanos: "25000" }])
  })
  test("serializes one stable job and replays it idempotently", async () => {
    // Regression proof: omit providerIds in toQueuePayload; the final record loses native IDs.
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      actorId: "assistant",
      runId: "run_1",
      executionId,
    })

    const record = modelCall()
    await enqueueAiModelCallRecovery(queues.agents, accounting(record))
    await enqueueAiModelCallRecovery(queues.agents, accounting(record))

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
      requestedReasoning: { budgetTokens: 4_096 },
      occurredAt: "2026-07-01T12:00:00.000Z",
      providerIds: record.providerIds,
    })
    expect(claimed.job.payload.record).not.toHaveProperty("projectId")
    expect(claimed.job.payload.record).not.toHaveProperty("recordedAt")
    expect(claimed.job.payload.record.usage).toMatchObject({ cacheReadInputTokens: 0 })

    await expect(recordRecoveredAiModelCall(storage, claimed.job)).resolves.toMatchObject({
      created: true,
      record: { providerIds: record.providerIds },
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

  test("recovers route and completed-call valuation atomically for current jobs", async () => {
    const queues = new InMemoryQueues()
    const storage = new InMemoryStorage()
    await createTestAgentExecution(storage, {
      projectId,
      actorId: "assistant",
      runId: "run_1",
      executionId,
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage: modelCall(),
      cost: {
        status: "rated",
        money: { currency: "USD", amountNanos: "95000" },
        components: [
          {
            meter: "tokens.input.total",
            quantity: "12",
            rateAmountNanosPerMillion: "1250000000",
            chargeAmountNanos: "15000",
          },
          {
            meter: "tokens.output.total",
            quantity: "8",
            rateAmountNanosPerMillion: "10000000000",
            chargeAmountNanos: "80000",
          },
        ],
      },
      route: { providerId: "openai", modelId: "gpt-5-2026-08-01" },
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
      cost: {
        status: "rated",
        money: { currency: "USD", amountNanos: "95000" },
        components: [
          {
            meter: "tokens.input.total",
            quantity: "12",
            rateAmountNanosPerMillion: "1250000000",
            chargeAmountNanos: "15000",
          },
          {
            meter: "tokens.output.total",
            quantity: "8",
            rateAmountNanosPerMillion: "10000000000",
            chargeAmountNanos: "80000",
          },
        ],
      },
      route: { providerId: "openai", modelId: "gpt-5-2026-08-01" },
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
            billingIdentity: { providerId: "gateway", modelId: "openai/gpt-5" },
            pricingContext: {
              routedProviderId: "openai",
              routedModelId: "gpt-5-2026-08-01",
            },
            priceSource: {
              sourceId: "model-rate-card",
              sourceEntryId: "gateway/openai/gpt-5",
            },
            money: { currency: "USD", amountNanos: "95000" },
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
      cost: { status: "unpriceable", reason: "missing-rate-card" },
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
      cost: { status: "unpriceable", reason: "missing-rate-card" },
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
        "[SixbModels] AI usage recovery job 'agt_usage_job_usage_1' has an invalid occurredAt timestamp.",
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
