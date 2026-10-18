import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage, type ReadonlyJsonValue } from "../src"
import {
  isPermanentAiUsageRecoveryError,
  recordRecoveredAiModelCall,
} from "../src/models/execution/model-call-recovery"
import { enqueueAiModelCallRecovery } from "../src/models/execution/recovery-queue"
import type { RecoverAiModelCallInput } from "../src/models/execution/types"
import type { AgentAiUsageRecordRequestedQueueJob } from "../src/queues"
import { AiUsageStorageError, type RecordAiModelCallInput } from "../src/storage"
import { createTestAgentExecution } from "../src/testing"

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

async function setup() {
  const queues = new InMemoryQueues()
  const storage = new InMemoryStorage()
  await createTestAgentExecution(storage, {
    projectId,
    actorId: "assistant",
    runId: "run_1",
    executionId,
  })
  return { queues, storage }
}

/** Claims the only recovery job; a stable job ID collapses a retried enqueue into one job. */
async function claimRecovery(queues: InMemoryQueues) {
  const claims = await queues.agents.claim({ projectId, workerId: "test-worker", limit: 2 })
  expect(claims).toHaveLength(1)
  const job = claims[0]?.job
  if (job?.type !== "agent.ai-usage.record.requested") {
    throw new Error("Expected an AI usage recovery job.")
  }
  return job
}

describe("AI usage recovery", () => {
  // Removal proof: omit modelKind, audioDurationMs, or the estimate from either recovery codec.
  test("replays audio accounting idempotently with independent reported cost and duration estimate", async () => {
    const { queues, storage } = await setup()
    const usage = {
      ...modelCall(),
      modelKind: "transcription" as const,
      usage: { audioDurationMs: 1250 },
    }
    const estimate = {
      status: "rated" as const,
      money: { currency: "USD" as const, amountNanos: "125000" },
      components: [
        {
          meter: "audio.input.milliseconds" as const,
          quantity: "1250",
          rateAmountNanosPerMillion: "100000000",
          chargeAmountNanos: "125000",
        },
      ],
    }
    await enqueueAiModelCallRecovery(queues.agents, {
      usage,
      estimate,
      cost: { status: "reported", money: { currency: "USD", amountNanos: "200000" } },
      ratedAt: usage.occurredAt,
    })
    const job = await claimRecovery(queues)
    await recordRecoveredAiModelCall(storage, job)
    await recordRecoveredAiModelCall(storage, job)
    const page = await storage.aiCosts.listModelCalls({
      projectId,
      from: new Date("2026-07-01"),
      to: new Date("2026-07-02"),
    })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({
      usage: { modelKind: "transcription", usage: { audioDurationMs: 1250 } },
      cost: { money: { amountNanos: "200000" }, estimate },
    })
    expect(
      (await storage.aiCosts.summarizeExecutions({ projectId, executionIds: [executionId] }))[0]
        ?.amounts
    ).toEqual([{ currency: "USD", amountNanos: "200000" }])
  })
  test("serializes one stable job and replays it idempotently", async () => {
    // Regression proof: omit providerIds in toQueuePayload; the final record loses native IDs.
    const { queues, storage } = await setup()
    const record = modelCall()
    await enqueueAiModelCallRecovery(queues.agents, accounting(record))
    await enqueueAiModelCallRecovery(queues.agents, accounting(record))

    const job = await claimRecovery(queues)
    expect(job.id).toBe(`agt_usage_job_${record.id}`)
    const jsonRecord: ReadonlyJsonValue = job.payload.record
    expect(jsonRecord).toMatchObject({
      id: "usage_1",
      executionId,
      requestedReasoning: { budgetTokens: 4_096 },
      occurredAt: "2026-07-01T12:00:00.000Z",
      providerIds: record.providerIds,
    })
    expect(job.payload.record).not.toHaveProperty("projectId")
    expect(job.payload.record).not.toHaveProperty("recordedAt")
    expect(job.payload.record.usage).toMatchObject({ cacheReadInputTokens: 0 })

    await expect(recordRecoveredAiModelCall(storage, job)).resolves.toMatchObject({
      created: true,
      record: { providerIds: record.providerIds },
    })
    await expect(recordRecoveredAiModelCall(storage, job)).resolves.toMatchObject({
      created: false,
    })
    await expect(
      storage.aiUsage.summarizeExecution({ projectId, executionId })
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
  })

  test("recovers route and completed-call valuation atomically", async () => {
    const { queues, storage } = await setup()
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
    const job = await claimRecovery(queues)
    expect(job.payload.accounting).toEqual({
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

    await expect(recordRecoveredAiModelCall(storage, job)).resolves.toMatchObject({
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

  test.each([
    {
      name: "reconciles the original reservation with measured usage",
      usage: modelCall().usage,
      expected: { accountingStatus: "complete", actual: 20, unknown: 0 },
    },
    {
      name: "keeps the reservation as unknown when recovered usage cannot be measured",
      usage: {},
      expected: { accountingStatus: "unavailable", actual: 0, unknown: 100 },
    },
  ])("durable accounting recovery $name", async ({ usage, expected }) => {
    const { queues, storage } = await setup()
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
      reservedAt: new Date("2026-07-01T11:59:59.000Z"),
    })
    await enqueueAiModelCallRecovery(queues.agents, {
      usage: { ...modelCall(), usage },
      cost: { status: "unpriceable", reason: "missing-rate-card" },
      ratedAt: new Date("2026-07-01T12:00:01.000Z"),
      reconcileLimitReservation: true,
    })
    const job = await claimRecovery(queues)
    expect(job.payload.accounting.reconcileLimitReservation).toBe(true)

    await expect(recordRecoveredAiModelCall(storage, job)).resolves.toMatchObject({
      created: true,
    })
    await expect(
      storage.aiLimits.listPolicyStatuses({
        projectId,
        at: new Date("2026-07-15T00:00:00.000Z"),
      })
    ).resolves.toMatchObject([
      {
        accountingStatus: expected.accountingStatus,
        consumption: {
          actual: { amount: expected.actual },
          reserved: { amount: 0 },
          unknown: { amount: expected.unknown },
        },
      },
    ])
  })

  test("rejects malformed jobs instead of retrying them forever", async () => {
    const record = modelCall()
    const job: AgentAiUsageRecordRequestedQueueJob = {
      id: `agt_usage_job_${record.id}`,
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
        accounting: {
          cost: { status: "unpriceable", reason: "missing-rate-card" },
          ratedAt: record.occurredAt.toISOString(),
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
