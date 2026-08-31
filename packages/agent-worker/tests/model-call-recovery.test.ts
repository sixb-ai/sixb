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

  test("recovers the model definition, route, and valuation atomically for current jobs", async () => {
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
      definition: {
        kind: "language",
        providerId: "gateway",
        modelId: "openai/gpt-5",
        capabilities: {},
        pricing: {
          currency: "USD",
          unit: "million-tokens",
          input: "1.25",
          output: "10",
        },
      },
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
      definition: {
        kind: "language",
        providerId: "gateway",
        modelId: "openai/gpt-5",
        capabilities: {},
        pricing: {
          currency: "USD",
          unit: "million-tokens",
          input: "1.25",
          output: "10",
        },
      },
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
              sourceId: "model-definition",
              sourceEntryId: "gateway/openai/gpt-5",
            },
            money: { currency: "USD", amountNanos: "95000" },
          },
        },
      ],
    })
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
