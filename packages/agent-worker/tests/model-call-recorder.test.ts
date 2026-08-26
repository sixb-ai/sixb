import { describe, expect, test } from "bun:test"
import type { RecordAiModelCallInput } from "@sixb/core/storage"
import {
  AiUsageStorageError,
  InMemoryStorage,
  normalizeAiModelCallRecord,
} from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { generateText, type LanguageModelCallEndEvent, type LanguageModelCallStartEvent } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { AgentUsageRecordingError } from "../src/errors"
import { AiModelCallRecorder } from "../src/model-call-recorder"
import type { RecoverAiModelCall } from "../src/types"

const occurredAt = new Date("2026-07-01T12:00:00.000Z")
const executionId = "test_agent_execution:run_1"
function callEndEvent(): LanguageModelCallEndEvent {
  return {
    callId: "call_1",
    provider: "gateway",
    modelId: "openai/gpt-5",
    finishReason: "stop",
    usage: {
      inputTokens: 12,
      inputTokenDetails: {
        noCacheTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
      },
      outputTokens: 8,
      outputTokenDetails: {
        textTokens: 6,
        reasoningTokens: 2,
      },
      totalTokens: 20,
      raw: {
        input_tokens: 12,
        output_tokens: 8,
        provider_meter: 4,
        omitted_optional_meter: undefined,
      },
    },
    content: [],
    responseId: "response_1",
    performance: {
      responseTimeMs: 100,
      effectiveOutputTokensPerSecond: 80,
      outputTokensPerSecond: 75,
      inputTokensPerSecond: 120,
      effectiveTotalTokensPerSecond: 200,
      timeToFirstOutputMs: 20,
    },
  }
}

function recorder(
  storage: InMemoryStorage,
  internals: ConstructorParameters<typeof AiModelCallRecorder>[1] = {},
  recoverAiModelCall: RecoverAiModelCall = async () => {
    throw new Error("Unexpected AI usage recovery handoff.")
  }
): AiModelCallRecorder {
  return new AiModelCallRecorder(
    {
      storage,
      projectId: "project_1",
      executionId,
      attempt: 2,
      requesterGroupIds: ["support", "engineering"],
      recoverAiModelCall,
      errorRunId: "run_1",
    },
    internals
  )
}

async function createInMemoryStorage(): Promise<InMemoryStorage> {
  const bundle = new InMemoryStorage()
  await createTestAgentExecution(bundle, {
    projectId: "project_1",
    agentId: "assistant",
    runId: "run_1",
    executionId,
  })
  return bundle
}

async function recordedCall(storage: InMemoryStorage, usageRecordId: string) {
  const result = await storage.aiCosts.listModelCalls({
    projectId: "project_1",
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-02T00:00:00.000Z"),
  })
  return result.items.find((item) => item.usage.id === usageRecordId)
}

async function recordedUsage(storage: InMemoryStorage, usageRecordId: string) {
  return (await recordedCall(storage, usageRecordId))?.usage
}

describe("AiModelCallRecorder", () => {
  test("captures the provider response model identity through middleware", async () => {
    const storage = await createInMemoryStorage()
    const usage = recorder(storage, {
      generateId: () => "usage_response_model",
      now: () => occurredAt,
    })
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-opus-4-8",
      doGenerate: {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        response: {
          id: "response_served",
          modelId: "claude-opus-4-8-20260801",
        },
        providerMetadata: { anthropic: { serviceTier: "standard" } },
        warnings: [],
      },
    })

    await generateText({
      model: usage.wrapModel(model),
      prompt: "hello",
      onLanguageModelCallStart: usage.onLanguageModelCallStart,
      onLanguageModelCallEnd: usage.onLanguageModelCallEnd,
    })

    const record = await recordedUsage(storage, "usage_response_model")
    expect(record).toMatchObject({
      requestedModelId: "claude-opus-4-8",
      responseModelId: "claude-opus-4-8-20260801",
      responseId: "response_served",
      rawUsage: { providerMetadata: { anthropic: { serviceTier: "standard" } } },
    })
  })

  test("retries and records one complete provider call with stable identity", async () => {
    const inputs: RecordAiModelCallInput[] = []
    const delays: number[] = []
    let attempts = 0
    const storage = await createInMemoryStorage()
    const usage = recorder(storage, {
      generateId: () => "usage_1",
      now: () => occurredAt,
      retryDelaysMs: [10, 20],
      sleep: async (ms) => {
        delays.push(ms)
      },
      recordAccounting: async (input) => {
        attempts += 1
        inputs.push(structuredClone(input.usage))
        if (attempts < 3) throw new Error("temporary storage failure")
        normalizeAiModelCallRecord(input.usage)
      },
    })

    await usage.onLanguageModelCallEnd(callEndEvent())
    expect(attempts).toBe(3)
    expect(delays).toEqual([10, 20])
    expect(inputs).toHaveLength(3)
    expect(inputs[0]).toEqual({
      id: "usage_1",
      projectId: "project_1",
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
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 0,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
      },
      rawUsage: { input_tokens: 12, output_tokens: 8, provider_meter: 4 },
      occurredAt,
    })
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[2]).toEqual(inputs[0])
    expect(usage.prepareStep()).toBeUndefined()
  })

  test("atomically records request context and a Models.dev valuation", async () => {
    const bundle = new InMemoryStorage()
    await createTestAgentExecution(bundle, {
      projectId: "project_1",
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })
    const times = [new Date("2026-07-01T11:59:59.000Z"), occurredAt]
    const usage = new AiModelCallRecorder(
      {
        storage: bundle,
        projectId: "project_1",
        executionId,
        attempt: 2,
        requesterGroupIds: [],
        providerOptions: {
          gateway: { serviceTier: "standard", batch: false, apiKey: "must-not-persist" },
        },
        recoverAiModelCall: async () => {
          throw new Error("Unexpected recovery")
        },
        errorRunId: "run_1",
      },
      {
        generateId: () => "usage_atomic",
        now: () => times.shift() ?? occurredAt,
      }
    )

    await usage.onLanguageModelCallStart({
      callId: "call_1",
      provider: "gateway",
    } as LanguageModelCallStartEvent)
    await usage.onLanguageModelCallEnd(callEndEvent())
    usage.assertHealthy()

    await expect(recordedCall(bundle, "usage_atomic")).resolves.toMatchObject({
      cost: {
        status: "rated",
        pricingContext: { serviceTier: "standard", batch: false },
        priceSource: { sourceId: "models.dev", sourceEntryId: "vercel/openai/gpt-5" },
        money: { currency: "USD", amountNanos: "91625" },
      },
    })
  })

  test("records unsupported deployment context as unpriceable without losing usage", async () => {
    const bundle = new InMemoryStorage()
    await createTestAgentExecution(bundle, {
      projectId: "project_1",
      agentId: "assistant",
      runId: "run_1",
      executionId,
    })
    const usage = new AiModelCallRecorder(
      {
        storage: bundle,
        projectId: "project_1",
        executionId,
        attempt: 1,
        requesterGroupIds: [],
        providerOptions: { gateway: { deploymentId: "production" } },
        recoverAiModelCall: async () => {
          throw new Error("Unexpected recovery")
        },
        errorRunId: "run_1",
      },
      {
        generateId: () => "usage_deployment",
        now: () => occurredAt,
      }
    )

    await usage.onLanguageModelCallStart({
      callId: "call_1",
      provider: "gateway",
    } as LanguageModelCallStartEvent)
    await usage.onLanguageModelCallEnd(callEndEvent())
    usage.assertHealthy()

    await expect(recordedCall(bundle, "usage_deployment")).resolves.toMatchObject({
      cost: {
        status: "unpriceable",
        reason: "unsupportedPricingDimension",
        pricingContext: { deploymentId: "production" },
      },
    })
    await expect(
      bundle.aiUsage.summarizeExecution({ projectId: "project_1", executionId })
    ).resolves.toMatchObject({ modelCallCount: 1 })
  })

  test("deduplicates a repeated lifecycle callback without double-counting usage", async () => {
    // The recorder deliberately generates a fresh row ID for each callback. Removing the storage
    // idempotency lookup makes this exact callback replay produce two records and double the total.
    const storage = await createInMemoryStorage()
    let nextId = 0
    const usage = recorder(storage, {
      generateId: () => `usage_${++nextId}`,
      now: () => occurredAt,
    })

    const event = callEndEvent()
    await usage.onLanguageModelCallEnd(event)
    await usage.onLanguageModelCallEnd(event)

    expect(nextId).toBe(2)
    await expect(
      storage.aiUsage.summarizeExecution({
        projectId: "project_1",
        executionId,
      })
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
  })

  test("preserves entirely missing callback usage without inventing zeroes", async () => {
    // Default any omitted SDK count to zero in the adapter and both assertions below fail.
    const storage = await createInMemoryStorage()
    const usage = recorder(storage, {
      generateId: () => "usage_missing",
      now: () => occurredAt,
    })
    const event: LanguageModelCallEndEvent = {
      ...callEndEvent(),
      usage: {
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
        totalTokens: undefined,
        raw: undefined,
      },
    }

    await usage.onLanguageModelCallEnd(event)

    const record = await recordedUsage(storage, "usage_missing")
    expect(record?.usage).toEqual({ reportingStatus: "unavailable" })
    expect(record?.rawUsage).toBeUndefined()
    await expect(
      storage.aiUsage.summarizeExecution({
        projectId: "project_1",
        executionId,
      })
    ).resolves.toEqual({
      modelCallCount: 1,
      usage: { reportingStatus: "unavailable" },
    })
  })

  test("hands a persistent storage failure to durable recovery and blocks the next step", async () => {
    let attempts = 0
    const recovered: RecordAiModelCallInput[] = []
    const storage = await createInMemoryStorage()
    const usage = recorder(
      storage,
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          attempts += 1
          throw new Error("storage unavailable")
        },
      },
      async (input) => {
        recovered.push(structuredClone(input.usage))
      }
    )

    await expect(usage.onLanguageModelCallEnd(callEndEvent())).resolves.toBeUndefined()
    expect(attempts).toBe(3)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ executionId, callId: "call_1" })
    let failure: unknown
    try {
      usage.prepareStep()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AgentUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: true })
  })

  test("blocks the next model step when storage and durable recovery both fail", async () => {
    let storageAttempts = 0
    let recoveryAttempts = 0
    const storage = await createInMemoryStorage()
    const usage = recorder(
      storage,
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          storageAttempts += 1
          throw new Error("storage unavailable")
        },
      },
      async () => {
        recoveryAttempts += 1
        throw new Error("queue unavailable")
      }
    )

    await expect(usage.onLanguageModelCallEnd(callEndEvent())).resolves.toBeUndefined()
    expect(storageAttempts).toBe(3)
    expect(recoveryAttempts).toBe(3)
    let failure: unknown
    try {
      usage.prepareStep()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AgentUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: false })
  })

  test("does not retry or enqueue a permanently invalid ledger append", async () => {
    let storageAttempts = 0
    let recoveryAttempts = 0
    const storage = await createInMemoryStorage()
    const usage = recorder(
      storage,
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          storageAttempts += 1
          throw new AiUsageStorageError("missing_execution", "missing execution")
        },
      },
      async () => {
        recoveryAttempts += 1
      }
    )

    await usage.onLanguageModelCallEnd(callEndEvent())
    expect(storageAttempts).toBe(1)
    expect(recoveryAttempts).toBe(0)
    let failure: unknown
    try {
      usage.prepareStep()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AgentUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: false })
  })

  test("retains failures raised while constructing the callback record", async () => {
    let records = 0
    const storage = await createInMemoryStorage()
    const usage = recorder(storage, {
      generateId: () => {
        throw new Error("ID generation unavailable")
      },
      recordAccounting: async () => {
        records += 1
      },
    })

    await expect(usage.onLanguageModelCallEnd(callEndEvent())).resolves.toBeUndefined()
    expect(records).toBe(0)
    expect(() => usage.prepareStep()).toThrow(AgentUsageRecordingError)
  })
})
