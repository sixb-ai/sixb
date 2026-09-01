import { describe, expect, test } from "bun:test"
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
import { createAiModelCallLimitController } from "../src/model-call-limits"
import { AiModelCallRecorder } from "../src/model-call-recorder"

const projectId = "limits-runtime"
const executionId = "test_agent_execution:run"
const rateCard = { currency: "USD", unit: "million-tokens", input: "1", output: "1" } as const
async function setup(events: () => AsyncIterable<LanguageModelStreamEvent>) {
  const storage = new InMemoryStorage()
  await createTestAgentExecution(storage, {
    projectId,
    executionId,
    agentId: "assistant",
    runId: "run",
  })
  const controller = createAiModelCallLimitController({ storage, projectId, requesterGroupIds: [] })
  const recorder = new AiModelCallRecorder({
    storage,
    projectId,
    executionId,
    attempt: 1,
    requesterGroupIds: [],
    ...controller,
    errorRunId: "run",
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
      onModelCallEnd: recorder.onModelCallEnd,
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
