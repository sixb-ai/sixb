import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import {
  defineLanguageModel,
  estimateModelReservation,
  type LanguageModel,
  type LanguageModelStreamEvent,
  rateModelCall,
} from "@sixb/core/models"
import { type AiLimitPolicyStatus, InMemoryStorage } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { MODEL_CALL_RETRY } from "../src/agents/model-call-retry"
import { createAiModelCallLimitController } from "../src/models/execution/model-call-limits"
import { AiModelCallRecorder } from "../src/models/execution/model-call-recorder"

const projectId = "limits-runtime"
const executionId = "test_agent_execution:run"
const rateCard = { currency: "USD", input: "1", output: "1" } as const
async function setup(events: () => AsyncIterable<LanguageModelStreamEvent>) {
  const storage = new InMemoryStorage()
  await createTestAgentExecution(storage, {
    projectId,
    executionId,
    runId: "run",
  })
  const controller = createAiModelCallLimitController({ storage, projectId, requesterGroupIds: [] })
  const recorder = new AiModelCallRecorder({
    storage,
    projectId,
    executionId,
    attempt: 1,
    requesterGroupIds: [],
    limits: controller,
    recoverAiModelCall: async () => {
      throw new Error("Unexpected recovery")
    },
  })
  let providerCalls = 0
  let reservedAtCall: readonly AiLimitPolicyStatus[] = []
  const model: LanguageModel = {
    providerId: "test",
    modelId: "model",
    definition: defineLanguageModel({
      kind: "language",
      providerId: "test",
      modelId: "model",
      capabilities: {},
    }),
    costEstimator: {
      estimate: ({ usage }) => rateModelCall({ usage, rateCard }),
      estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard }),
    },
    async stream() {
      providerCalls++
      reservedAtCall = await storage.aiLimits.listPolicyStatuses({ projectId })
      return { events: events() }
    },
  }
  let callIndex = 0
  const run = () =>
    runModelLoop({
      model: recorder.wrapModel(model),
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      maxSteps: 2,
      signal: new AbortController().signal,
      generateCallId: () => `call-${++callIndex}`,
    })
  return {
    storage,
    recorder,
    model,
    run,
    reservedAtCall: () => reservedAtCall,
    providerCalls: () => providerCalls,
  }
}

describe("model runtime reservations", () => {
  // Removal proof: bypass wrapModel admission/reconciliation and run this file; these guards fail.
  test("rechecks capacity before each continuation and reconciles the completed call", async () => {
    const context = await setup(async function* () {
      yield { type: "stream-start" }
      yield { type: "finish", finishReason: "pause", usage: { inputTokens: 1000, outputTokens: 0 } }
    })
    await context.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 4500 },
    })
    await expect(context.run()).rejects.toMatchObject({ code: "ai.usage_limit_exceeded" })
    expect(context.providerCalls()).toBe(1)
    expect(() => context.recorder.assertHealthy()).toThrow(
      expect.objectContaining({ code: "ai.usage_limit_exceeded" })
    )
    expect((await context.storage.aiLimits.listPolicyStatuses({ projectId }))[0]).toMatchObject({
      consumption: { actual: { amount: 1000 }, reserved: { amount: 0 } },
    })
  })
  test("admits a priced model and replaces its cost reservation with observed consumption", async () => {
    const context = await setup(async function* () {
      yield { type: "stream-start" }
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }
    })
    await context.storage.aiLimits.createPolicy({
      id: "cost",
      projectId,
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })
    await context.run()
    const reservedCost = context.reservedAtCall()[0]?.consumption.reserved
    if (reservedCost?.meter !== "cost.catalogEstimated")
      throw new Error("Expected cost reservation")
    expect(BigInt(reservedCost.amount.amountNanos)).toBeGreaterThan(0n)
    expect(context.providerCalls()).toBe(1)
    expect((await context.storage.aiLimits.listPolicyStatuses({ projectId }))[0]).toMatchObject({
      accountingStatus: "complete",
      consumption: {
        actual: { amount: { amountNanos: "15000" } },
        reserved: { amount: { amountNanos: "0" } },
      },
    })
  })
  test("retains capacity when an accepted stream fails without final usage", async () => {
    const context = await setup(async function* () {
      yield { type: "stream-start" }
      throw new Error("connection lost")
    })
    await context.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 4500 },
    })
    await expect(context.run()).rejects.toThrow("connection lost")
    const [status] = await context.storage.aiLimits.listPolicyStatuses({ projectId })
    expect(status).toMatchObject({
      accountingStatus: "unavailable",
      consumption: { actual: { amount: 0 }, reserved: { amount: 0 } },
    })
    expect(status?.consumption.unknown.amount).toBeGreaterThan(4096)
  })
})

describe("a model call that lost its connection, asked again", () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  const reset = () =>
    Object.assign(new TypeError("ECONNRESET: The socket connection was closed."), {
      code: "ECONNRESET",
    })

  /** Run the loop with fake timers, waiting out the one pause it makes before it asks again. */
  async function outlastPause<T>(run: () => Promise<T>): Promise<T> {
    jest.useFakeTimers()
    const paused = Promise.withResolvers<void>()
    spyOn(console, "warn").mockImplementation(() => paused.resolve())

    const result = run()
    await paused.promise
    jest.advanceTimersByTime(MODEL_CALL_RETRY.maxMs)
    return result
  }

  async function tokenLimit(storage: InMemoryStorage) {
    await storage.aiLimits.createPolicy({
      id: "tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1_000_000 },
    })
  }

  // The retry is a new call: replayed inside the lost one (one call ID, one admission), the lost
  // call, which may have been billed, would leave the ledger. Reproduce the check: drop the
  // connectionLost retry in runModelLoop; the run then fails with the reset.
  test("records the lost call with its usage unknown, and the call that answers with its own", async () => {
    let opened = 0
    const context = await setup(async function* () {
      opened += 1
      yield { type: "stream-start" }
      if (opened === 1) throw reset()
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }
    })

    expect(await outlastPause(context.run)).toMatchObject({ status: "completed" })

    expect(context.providerCalls()).toBe(2)
    expect(
      await context.storage.aiUsage.summarizeExecution({ projectId, executionId })
    ).toMatchObject({
      modelCallCount: 2,
      // Never free: one call's usage is unknown, so the execution's is not complete.
      usage: { reportingStatus: "partial" },
    })
    expect(
      await context.storage.aiUsage.getLatestForExecution({ projectId, executionId })
    ).toMatchObject({ callId: "call-2", usage: { inputTokens: 10, outputTokens: 5 } })
  })

  // A limit cannot count a call whose usage is unknown, so it refuses the next one, as it does
  // whenever an accepted call fails mid-stream: asking again never gets around a limit.
  test("is refused by a limit the lost call left unable to count", async () => {
    let opened = 0
    const context = await setup(async function* () {
      opened += 1
      yield { type: "stream-start" }
      if (opened === 1) throw reset()
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }
    })
    await tokenLimit(context.storage)

    const error = await outlastPause(() => context.run().catch((error: unknown) => error))

    expect(error).toMatchObject({ code: "ai.usage_limit_unavailable" })
    expect(context.providerCalls()).toBe(1)
  })

  test("keeps the reservation of a call lost before it answered, which records nothing", async () => {
    let opened = 0
    const context = await setup(() => {
      opened += 1
      if (opened === 1) throw reset()
      return (async function* () {
        yield { type: "stream-start" } as const
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        } as const
      })()
    })
    await tokenLimit(context.storage)

    expect(await outlastPause(context.run)).toMatchObject({ status: "completed" })

    expect(context.providerCalls()).toBe(2)
    expect(
      await context.storage.aiUsage.summarizeExecution({ projectId, executionId })
    ).toMatchObject({ modelCallCount: 1 })
    const [status] = await context.storage.aiLimits.listPolicyStatuses({ projectId })
    expect(status).toMatchObject({ consumption: { actual: { amount: 15 } } })
    expect(status?.consumption.unknown.amount).toBeGreaterThan(4096)
  })
})
