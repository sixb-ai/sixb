import { describe, expect, test } from "bun:test"
import type {
  AiUsageExecutionSummary,
  AiUsageStorage,
  RecordAiModelCallInput,
} from "@sixb/core/storage"
import {
  AiUsageStorageError,
  InMemoryAiUsageStorage,
  InMemoryStorage,
  normalizeAiModelCallRecord,
} from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import type { LanguageModelCallEndEvent } from "ai"
import { AgentUsageRecordingError } from "../src/errors"
import { AiModelCallRecorder } from "../src/model-call-recorder"

const occurredAt = new Date("2026-07-01T12:00:00.000Z")
const executionId = "test_agent_execution:run_1"
const emptySummary: AiUsageExecutionSummary = {
  modelCallCount: 0,
  usage: { reportingStatus: "unavailable" },
}

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
        cacheWriteTokens: 1,
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
  storage: AiUsageStorage,
  internals: ConstructorParameters<typeof AiModelCallRecorder>[1] = {},
  recoverAiModelCall: (record: RecordAiModelCallInput) => Promise<void> = async () => {
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

async function createInMemoryUsageStorage(): Promise<InMemoryAiUsageStorage> {
  const bundle = new InMemoryStorage()
  await createTestAgentExecution(bundle, {
    projectId: "project_1",
    agentId: "assistant",
    runId: "run_1",
    executionId,
  })
  return new InMemoryAiUsageStorage(bundle.executions)
}

describe("AiModelCallRecorder", () => {
  test("retries and records one complete provider call with stable identity", async () => {
    const inputs: RecordAiModelCallInput[] = []
    const delays: number[] = []
    let attempts = 0
    const storage: AiUsageStorage = {
      async recordModelCall(input) {
        attempts += 1
        inputs.push(structuredClone(input))
        if (attempts < 3) throw new Error("temporary storage failure")
        return { record: normalizeAiModelCallRecord(input), created: true }
      },
      async summarizeExecution(): Promise<AiUsageExecutionSummary> {
        return emptySummary
      },
      async summarizeExecutions() {
        return []
      },
    }
    const usage = recorder(storage, {
      generateId: () => "usage_1",
      now: () => occurredAt,
      retryDelaysMs: [10, 20],
      sleep: async (ms) => {
        delays.push(ms)
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
        cacheWriteInputTokens: 1,
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

  test("deduplicates a repeated lifecycle callback without double-counting usage", async () => {
    // The recorder deliberately generates a fresh row ID for each callback. Removing the storage
    // idempotency lookup makes this exact callback replay produce two records and double the total.
    const storage = await createInMemoryUsageStorage()
    let nextId = 0
    const usage = recorder(storage, {
      generateId: () => `usage_${++nextId}`,
      now: () => occurredAt,
    })

    const event = callEndEvent()
    await usage.onLanguageModelCallEnd(event)
    await usage.onLanguageModelCallEnd(event)

    expect(nextId).toBe(2)
    expect(storage.snapshot().records.size).toBe(1)
    await expect(
      storage.summarizeExecution({
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
    const storage = await createInMemoryUsageStorage()
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

    const [record] = storage.snapshot().records.values()
    expect(record?.usage).toEqual({ reportingStatus: "unavailable" })
    expect(record?.rawUsage).toBeUndefined()
    await expect(
      storage.summarizeExecution({
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
    const storage: AiUsageStorage = {
      async recordModelCall() {
        attempts += 1
        throw new Error("storage unavailable")
      },
      async summarizeExecution(): Promise<AiUsageExecutionSummary> {
        return emptySummary
      },
      async summarizeExecutions() {
        return []
      },
    }
    const usage = recorder(
      storage,
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
      },
      async (record) => {
        recovered.push(structuredClone(record))
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
    const storage: AiUsageStorage = {
      async recordModelCall() {
        storageAttempts += 1
        throw new Error("storage unavailable")
      },
      async summarizeExecution(): Promise<AiUsageExecutionSummary> {
        return emptySummary
      },
      async summarizeExecutions() {
        return []
      },
    }
    const usage = recorder(
      storage,
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
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
    const storage: AiUsageStorage = {
      async recordModelCall() {
        storageAttempts += 1
        throw new AiUsageStorageError("missing_execution", "missing execution")
      },
      async summarizeExecution(): Promise<AiUsageExecutionSummary> {
        return emptySummary
      },
      async summarizeExecutions() {
        return []
      },
    }
    const usage = recorder(
      storage,
      { retryDelaysMs: [10, 20], sleep: async () => undefined },
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
    const storage: AiUsageStorage = {
      async recordModelCall(input) {
        records += 1
        return { record: normalizeAiModelCallRecord(input), created: true }
      },
      async summarizeExecution(): Promise<AiUsageExecutionSummary> {
        return emptySummary
      },
      async summarizeExecutions() {
        return []
      },
    }
    const usage = recorder(storage, {
      generateId: () => {
        throw new Error("ID generation unavailable")
      },
    })

    await expect(usage.onLanguageModelCallEnd(callEndEvent())).resolves.toBeUndefined()
    expect(records).toBe(0)
    expect(() => usage.prepareStep()).toThrow(AgentUsageRecordingError)
  })
})
