import { describe, expect, test } from "bun:test"
import { type ModelCallEndEvent, rateModelCall } from "@sixb/core/models"
import { AiUsageStorageError, InMemoryStorage } from "@sixb/core/storage"
import { ModelUsageRecordingError } from "../src/models/execution/errors"
import { recordAiModelCallAccounting } from "../src/models/execution/model-call-accounting"
import { createAiModelCallLimitController } from "../src/models/execution/model-call-limits"
import { AiModelCallRecorder } from "../src/models/execution/model-call-recorder"
import type {
  ModelCallAccountingStorage,
  RecoverAiModelCall,
  RecoverAiModelCallInput,
} from "../src/models/execution/types"

const occurredAt = new Date("2026-07-01T12:00:00.000Z")
const executionId = "test_request_execution:request_1"

function callEndEvent(): ModelCallEndEvent {
  return {
    callId: "call_1",
    providerId: "gateway",
    modelId: "openai/gpt-5",
    requestedReasoning: "high",
    responseModelId: "openai/gpt-5-2026-08-01",
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
      raw: {
        input_tokens: 12,
        output_tokens: 8,
        provider_meter: 4,
      },
    },
    responseId: "response_1",
    providerIds: { generationId: "gen_1", requestId: "req_1" },
    cost: {
      status: "reported",
      money: { currency: "USD", amountNanos: "42000" },
      providerId: "gateway",
    },
    route: { providerId: "openai", modelId: "openai/gpt-5-2026-08-01" },
  }
}

function recorder(
  storage: ModelCallAccountingStorage,
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
      limits: createAiModelCallLimitController({
        storage,
        projectId: "project_1",
        requesterGroupIds: ["support", "engineering"],
      }),
      recoverAiModelCall,
    },
    internals
  )
}

async function seededStorage() {
  const storage = new InMemoryStorage()
  await storage.executions.create({
    id: executionId,
    projectId: "project_1",
    executor: { type: "request", requestId: "request_1" },
    source: { type: "http", requestId: "request_1" },
    correlationId: "request_1",
    authorizationRef: { type: "disabled" },
  })
  return storage
}

describe("AiModelCallRecorder", () => {
  test.each([
    "aiUsage",
    "aiCosts",
    "aiLimits",
  ] as const)("requires %s before inference can start", (missing) => {
    // Removal proof: remove requireAccountingCapabilities from the recorder constructor.
    const storage = new InMemoryStorage()
    const incomplete = {
      aiUsage: storage.aiUsage,
      aiCosts: storage.aiCosts,
      aiLimits: storage.aiLimits,
      transaction: storage.transaction.bind(storage),
      [missing]: undefined,
    }
    // Model a JavaScript caller whose storage violates the required internal contract.
    expect(() => recorder(incomplete as ModelCallAccountingStorage)).toThrow(
      "AI model-call accounting requires storage.aiUsage, storage.aiCosts, and storage.aiLimits."
    )
  })

  test("invalid estimates cannot discard usage or inline provider costs", async () => {
    // Removal proof: bypass validatedEstimate in model-call-accounting; the first append rejects.
    const estimates = [
      {
        status: "rated" as const,
        money: { currency: "USD" as const, amountNanos: "2" },
        components: [],
      },
      rateModelCall({
        usage: { inputTokens: 1, outputTokens: 1 },
        rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "1" },
      }),
    ]
    for (const { reported, estimate } of estimates.flatMap((estimate) =>
      [true, false].map((reported) => ({ reported, estimate }))
    )) {
      const storage = await seededStorage()
      const event = callEndEvent()
      await recorder(storage, { now: () => occurredAt }).onModelCallEnd({
        ...event,
        cost: reported ? event.cost : estimate,
        ...(reported ? { estimate } : {}),
      })
      const page = await storage.aiCosts.listModelCalls({
        projectId: "project_1",
        from: new Date("2026-07-01"),
        to: new Date("2026-07-02"),
      })
      expect(page.total).toBe(1)
      expect(page.items[0]?.usage.usage.totalTokens).toBe(20)
      expect(page.items[0]?.cost).toMatchObject(
        reported
          ? {
              status: "rated",
              money: { amountNanos: "42000" },
              estimate: { status: "unpriceable" },
            }
          : { status: "unpriceable" }
      )
    }
  })
  test("sanitizes optional estimates before a durable recovery handoff", async () => {
    // Removal proof: construct recoveryInput without normalizeModelCallAccounting in the recorder.
    let recovered: RecoverAiModelCallInput | undefined
    const usage = recorder(
      await seededStorage(),
      {
        retryDelaysMs: [],
        recordAccounting: async () => {
          throw new Error("storage unavailable")
        },
      },
      async (input) => {
        recovered = input
      }
    )
    const event = callEndEvent()
    await expect(
      usage.onModelCallEnd({
        ...event,
        estimate: { status: "rated", money: { currency: "USD", amountNanos: "2" }, components: [] },
      })
    ).rejects.toMatchObject({ recoveryScheduled: true })
    expect(recovered?.estimate).toMatchObject({ status: "unpriceable" })
    expect(recovered?.cost).toEqual(event.cost)
    expect(recovered?.usage.usage.inputTokens).toBe(12)
  })
  test("retries and records one complete provider call with stable identity", async () => {
    // Removal proof: omit providerIds in the recorder's usage input.
    const inputs: RecoverAiModelCallInput[] = []
    const delays: number[] = []
    let attempts = 0
    const usage = recorder(new InMemoryStorage(), {
      generateId: () => "usage_1",
      now: () => occurredAt,
      retryDelaysMs: [10, 20],
      sleep: async (ms) => {
        delays.push(ms)
      },
      recordAccounting: async (input) => {
        attempts += 1
        inputs.push(structuredClone(input))
        if (attempts < 3) throw new Error("temporary storage failure")
      },
    })

    await usage.onModelCallEnd(callEndEvent())

    expect(attempts).toBe(3)
    expect(delays).toEqual([10, 20])
    expect(inputs).toHaveLength(3)
    expect(inputs[0]).toEqual({
      usage: {
        id: "usage_1",
        projectId: "project_1",
        executionId,
        attempt: 2,
        callId: "call_1",
        requesterGroupIds: ["support", "engineering"],
        providerId: "gateway",
        requestedModelId: "openai/gpt-5",
        requestedReasoning: "high",
        responseModelId: "openai/gpt-5-2026-08-01",
        responseId: "response_1",
        providerIds: { generationId: "gen_1", requestId: "req_1" },
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
      },
      cost: {
        status: "reported",
        money: { currency: "USD", amountNanos: "42000" },
        providerId: "gateway",
      },
      route: { providerId: "openai", modelId: "openai/gpt-5-2026-08-01" },
      ratedAt: occurredAt,
    })
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[2]).toEqual(inputs[0])
    expect(() => usage.assertHealthy()).not.toThrow()
  })

  test("deduplicates a repeated callback without duplicating usage or valuation", async () => {
    const storage = await seededStorage()
    let nextId = 0
    // A request execution needs only accounting stores, not an agent/auth/run store.
    const accounting: ModelCallAccountingStorage = {
      aiUsage: storage.aiUsage,
      aiCosts: storage.aiCosts,
      aiLimits: storage.aiLimits,
      transaction: storage.transaction.bind(storage),
    }
    const usage = recorder(accounting, {
      generateId: () => `usage_${++nextId}`,
      now: () => occurredAt,
    })

    const event = callEndEvent()
    await usage.onModelCallEnd(event)
    await usage.onModelCallEnd(event)

    expect(nextId).toBe(2)
    await expect(
      storage.aiUsage.summarizeExecution({ projectId: "project_1", executionId })
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
    await expect(
      storage.aiCosts.listModelCalls({
        projectId: "project_1",
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-07-02T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      items: [
        {
          cost: {
            status: "rated",
            money: { currency: "USD", amountNanos: "42000" },
            priceSource: { sourceId: "provider-reported" },
          },
        },
      ],
    })
  })

  test("preserves missing usage without inventing zeroes", async () => {
    const inputs: RecoverAiModelCallInput[] = []
    const usage = recorder(new InMemoryStorage(), {
      generateId: () => "usage_missing",
      now: () => occurredAt,
      recordAccounting: async (input) => {
        inputs.push(structuredClone(input))
      },
    })

    await usage.onModelCallEnd({
      ...callEndEvent(),
      usage: { inputTokens: undefined, outputTokens: undefined, raw: undefined },
    })

    expect(inputs[0]?.usage.usage).toEqual({})
    expect(inputs[0]?.usage.rawUsage).toBeUndefined()
  })

  test("hands a persistent accounting failure to durable recovery and blocks the next step", async () => {
    let attempts = 0
    const recovered: RecoverAiModelCallInput[] = []
    const usage = recorder(
      new InMemoryStorage(),
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          attempts += 1
          throw new Error("storage unavailable")
        },
      },
      async (input) => {
        recovered.push(structuredClone(input))
      }
    )

    const failure = await usage.onModelCallEnd(callEndEvent()).catch((error: unknown) => error)

    expect(attempts).toBe(3)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.usage).toMatchObject({ executionId, callId: "call_1" })
    expect(failure).toBeInstanceOf(ModelUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: true })
    expect(() => usage.assertHealthy()).toThrow(ModelUsageRecordingError)
  })

  test("blocks the next model step when accounting and durable recovery both fail", async () => {
    let accountingAttempts = 0
    let recoveryAttempts = 0
    const usage = recorder(
      new InMemoryStorage(),
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          accountingAttempts += 1
          throw new Error("storage unavailable")
        },
      },
      async () => {
        recoveryAttempts += 1
        throw new Error("queue unavailable")
      }
    )

    const failure = await usage.onModelCallEnd(callEndEvent()).catch((error: unknown) => error)

    expect(accountingAttempts).toBe(3)
    expect(recoveryAttempts).toBe(3)
    expect(failure).toBeInstanceOf(ModelUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: false })
  })

  test.each([
    false,
    true,
  ])("accounts for in-flight calls after another call fails (second recovery: %s)", async (recoverSecond) => {
    // Removal proof: restore the early recordingError throw in onModelCallEnd.
    // Also fails if a later error overwrites the execution's first accounting failure.
    const storage = await seededStorage()
    const recovered: string[] = []
    const attempts: string[] = []
    const usage = recorder(
      storage,
      {
        now: () => occurredAt,
        retryDelaysMs: [],
        recordAccounting: async (input) => {
          attempts.push(input.usage.callId)
          if (input.usage.callId === "first" || recoverSecond) {
            throw new Error("storage unavailable")
          }
          await recordAiModelCallAccounting({ storage, ...input })
        },
      },
      async (input) => {
        recovered.push(input.usage.callId)
      }
    )
    let providerCalls = 0
    const model = usage.wrapModel({
      providerId: "gateway",
      modelId: "openai/gpt-5",
      definition: {
        kind: "language",
        providerId: "gateway",
        modelId: "openai/gpt-5",
        capabilities: {},
      },
      async stream() {
        providerCalls += 1
        return { events: (async function* () {})() }
      },
    })
    const start = (callId: string) =>
      model.stream({
        callId,
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })
    // Both requests have reached the provider before either completes.
    await Promise.all([start("first"), start("second")])
    await expect(
      usage.onModelCallEnd({ ...callEndEvent(), callId: "first" })
    ).rejects.toMatchObject({ callId: "first", recoveryScheduled: true })

    const second = usage.onModelCallEnd({ ...callEndEvent(), callId: "second" })
    if (recoverSecond) {
      await expect(second).rejects.toMatchObject({ callId: "second", recoveryScheduled: true })
    } else {
      await second
      await expect(
        storage.aiUsage.summarizeExecution({ projectId: "project_1", executionId })
      ).resolves.toMatchObject({ modelCallCount: 1 })
    }
    expect(attempts).toEqual(["first", "second"])
    expect(recovered).toEqual(recoverSecond ? ["first", "second"] : ["first"])
    await expect(start("third")).rejects.toMatchObject({ callId: "first" })
    expect(providerCalls).toBe(2)
  })

  test("does not retry or enqueue a permanently invalid ledger append", async () => {
    let accountingAttempts = 0
    let recoveryAttempts = 0
    const usage = recorder(
      new InMemoryStorage(),
      {
        retryDelaysMs: [10, 20],
        sleep: async () => undefined,
        recordAccounting: async () => {
          accountingAttempts += 1
          throw new AiUsageStorageError("missing_execution", "missing execution")
        },
      },
      async () => {
        recoveryAttempts += 1
      }
    )

    const failure = await usage.onModelCallEnd(callEndEvent()).catch((error: unknown) => error)

    expect(accountingAttempts).toBe(1)
    expect(recoveryAttempts).toBe(0)
    expect(failure).toBeInstanceOf(ModelUsageRecordingError)
    expect(failure).toMatchObject({ recoveryScheduled: false })
  })

  test("retains failures raised while constructing the accounting record", async () => {
    let records = 0
    const usage = recorder(new InMemoryStorage(), {
      generateId: () => {
        throw new Error("ID generation unavailable")
      },
      recordAccounting: async () => {
        records += 1
      },
    })

    await expect(usage.onModelCallEnd(callEndEvent())).rejects.toBeInstanceOf(
      ModelUsageRecordingError
    )
    expect(records).toBe(0)
    expect(() => usage.assertHealthy()).toThrow(ModelUsageRecordingError)
  })
})
