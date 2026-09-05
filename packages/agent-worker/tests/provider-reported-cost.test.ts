import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage, type ReadonlyJsonValue } from "@sixb/core"
import type { AiModelCallUsageRecord, ReadonlyJsonObject } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { recordAiModelCallAccounting } from "../src/model-call-accounting"
import { enqueueAiModelCallRecovery, recordRecoveredAiModelCall } from "../src/model-call-recovery"
import { providerReportedCost } from "../src/provider-reported-cost"

const at = new Date("2026-09-01T12:00:00.000Z")
const routing = {
  modelAttempts: [{ providerAttempts: [{ credentialType: "system", success: true }] }],
}

function input(cost: ReadonlyJsonValue = "0.0005302", extra: ReadonlyJsonObject = {}) {
  const usage: AiModelCallUsageRecord = {
    id: "usage_1",
    projectId: "project_1",
    executionId: "exec_1",
    attempt: 1,
    callId: "call_1",
    requesterGroupIds: [],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5.6-luna",
    responseId: "response_1",
    usage: {
      inputTokens: 2059,
      outputTokens: 13,
      uncachedInputTokens: 3,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 2056,
      reportingStatus: "complete",
    },
    rawUsage: { providerMetadata: { gateway: { cost, generationId: "gen_1", routing, ...extra } } },
    occurredAt: at,
    recordedAt: at,
  }
  return { usage, pricingContext: { serviceTier: "default" }, ratedAt: at }
}

async function storage() {
  const bundle = new InMemoryStorage()
  await createTestAgentExecution(bundle, {
    projectId: "project_1",
    runId: "run_1",
    executionId: "exec_1",
  })
  return bundle
}

const query = {
  projectId: "project_1",
  from: at,
  to: new Date("2026-09-02T00:00:00.000Z"),
}

describe("provider-reported cost", () => {
  test("accepts the Gateway amount without needing cache TTL or inventing token rates", () => {
    expect(providerReportedCost(input())).toEqual({
      projectId: "project_1",
      usageRecordId: "usage_1",
      status: "reported",
      billingIdentity: { providerId: "gateway", modelId: "openai/gpt-5.6-luna" },
      pricingContext: { serviceTier: "default" },
      money: { currency: "USD", amountNanos: "530200" },
      reportSource: { providerId: "gateway", responseId: "gen_1" },
      ratedAt: at,
    })
  })

  test.each([
    ["0", "0"],
    [0, "0"],
    ["0.00099695", "996950"],
    ["0.00745208", "7452080"],
    ["0.0000000004", "0"],
    ["0.0000000005", "1"],
    [1e-9, "1"],
    ["1.9999999995", "2000000000"],
    ["9223372036.854775807", "9223372036854775807"],
  ] as const)("converts %s USD exactly with half-up nanounit rounding", (amount, nanos) => {
    expect(providerReportedCost(input(amount))?.money.amountNanos).toBe(nanos)
  })

  test("ignores malformed or out-of-range monetary reports", () => {
    for (const amount of [
      null,
      true,
      {},
      [],
      "",
      " ",
      "-1",
      -1,
      "NaN",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1.2USD",
      "0x10",
      "1e9999",
      "9223372036.854775808",
      "9".repeat(129),
    ]) {
      expect(providerReportedCost(input(amount))).toBeUndefined()
    }
  })

  test("does not trust another provider's metadata or an anonymous report", () => {
    const value = input()
    expect(
      providerReportedCost({
        ...value,
        usage: { ...value.usage, providerId: "custom" },
      })
    ).toBeUndefined()
    expect(providerReportedCost(input("0.1", { generationId: "" }))).toBeUndefined()
    expect(
      providerReportedCost({
        ...value,
        usage: { ...value.usage, rawUsage: {} },
      })
    ).toBeUndefined()
  })

  test.each<ReadonlyJsonValue>([
    null,
    {},
    { modelAttempts: [] },
    { modelAttempts: [{ providerAttempts: [] }] },
    { modelAttempts: [{ providerAttempts: [{ credentialType: "byok" }] }] },
    { modelAttempts: [{ providerAttempts: [{ credentialType: "unknown" }] }] },
    {
      modelAttempts: [
        { providerAttempts: [{ credentialType: "byok" }] },
        { providerAttempts: [{ credentialType: "system" }] },
      ],
    },
  ])("does not count Gateway-only or ambiguous charges as a complete BYOK cost: %j", (routing) => {
    expect(providerReportedCost(input("0", { routing }))).toBeUndefined()
  })

  test("prefers the report over Models.dev and preserves one immutable value on replay", async () => {
    // Negative control: removing providerReportedCost from recordAiModelCallAccounting
    // makes this fail with unsupportedPricingDimension for this missing-TTL fixture.
    const bundle = await storage()
    await recordAiModelCallAccounting({ storage: bundle, ...input() })
    await recordAiModelCallAccounting({ storage: bundle, ...input("999") })
    const result = await bundle.aiCosts.listModelCalls(query)
    expect(result.total).toBe(1)
    expect(result.items[0]?.cost).toEqual(providerReportedCost(input()))
    expect(
      await bundle.aiCosts.summarizeExecutions({
        projectId: query.projectId,
        executionIds: ["exec_1"],
      })
    ).toEqual([
      {
        amounts: [{ currency: "USD", amountNanos: "530200" }],
        reportedCallCount: 1,
        ratedCallCount: 0,
        unpriceableCallCount: 0,
        unvaluedCallCount: 0,
      },
    ])
  })

  test("falls back to catalog estimates only when the usage can safely be priced", async () => {
    const bundle = await storage()
    const value = input("invalid")
    await recordAiModelCallAccounting({
      storage: bundle,
      ...value,
      usage: {
        ...value.usage,
        requestedModelId: "openai/gpt-5",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          uncachedInputTokens: 1,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      },
    })
    expect((await bundle.aiCosts.listModelCalls(query)).items[0]?.cost?.status).toBe("rated")
  })

  test("keeps missing-TTL usage unpriceable when the monetary report is invalid", async () => {
    const bundle = await storage()
    await recordAiModelCallAccounting({ storage: bundle, ...input("invalid") })
    expect((await bundle.aiCosts.listModelCalls(query)).items[0]?.cost).toMatchObject({
      status: "unpriceable",
      reason: "unsupportedPricingDimension",
    })
  })

  test("recovers the same report from durable raw metadata without calling the model", async () => {
    const bundle = await storage()
    const queues = new InMemoryQueues()
    await enqueueAiModelCallRecovery(queues.agents, input())
    const [claimed] = await queues.agents.claim({
      projectId: query.projectId,
      workerId: "test",
      limit: 1,
    })
    if (claimed?.job.type !== "agent.ai-usage.record.requested")
      throw new Error("Missing recovery job")
    await recordRecoveredAiModelCall(bundle, claimed.job)
    await recordRecoveredAiModelCall(bundle, claimed.job)
    expect((await bundle.aiCosts.listModelCalls(query)).items[0]?.cost).toEqual(
      providerReportedCost(input())
    )
  })
})
