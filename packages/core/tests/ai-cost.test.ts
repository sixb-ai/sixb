import { describe, expect, test } from "bun:test"
import type { AiModelCallCostRecord } from "../src/storage/ai-cost"
import {
  aiModelCallCostMatchesUsage,
  normalizeAiModelCallCostRecord,
} from "../src/storage/ai-cost/validation"
import type { AiModelCallUsageRecord } from "../src/storage/ai-usage"

const usage: AiModelCallUsageRecord = {
  id: "usage_1",
  projectId: "project_1",
  executionId: "execution_1",
  attempt: 1,
  callId: "call_1",
  requesterGroupIds: [],
  providerId: "test-provider",
  requestedModelId: "test-model",
  responseId: "response_1",
  usage: {
    inputTokens: 12,
    outputTokens: 8,
    uncachedInputTokens: 9,
    cacheReadInputTokens: 3,
    reportingStatus: "complete",
    totalTokens: 20,
  },
  occurredAt: new Date("2026-08-25T00:00:00.000Z"),
  recordedAt: new Date("2026-08-25T00:00:00.100Z"),
}

function cost(): Extract<AiModelCallCostRecord, { status: "rated" }> {
  return {
    projectId: usage.projectId,
    usageRecordId: usage.id,
    status: "rated",
    billingIdentity: { providerId: "test-provider", modelId: "test-model" },
    pricingContext: {},
    priceSource: {
      sourceId: "test-catalog",
      sourceEntryId: "test-provider/test-model",
      sourceVersion: "test-catalog-v1",
      sourceUrl: "https://example.test/ai-pricing.json",
      observedAt: new Date("2026-08-25T00:00:00.000Z"),
    },
    money: { currency: "USD", amountNanos: "20" },
    components: [
      {
        meter: "tokens.input.uncached",
        quantity: "9",
        rateAmountNanosPerMillion: "1000000",
        chargeAmountNanos: "9",
      },
      {
        meter: "tokens.input.cacheRead",
        quantity: "3",
        rateAmountNanosPerMillion: "1000000",
        chargeAmountNanos: "3",
      },
      {
        meter: "tokens.output.total",
        quantity: "8",
        rateAmountNanosPerMillion: "1000000",
        chargeAmountNanos: "8",
      },
    ],
    ratedAt: new Date("2026-08-25T00:00:01.000Z"),
  }
}

describe("AI cost record validation", () => {
  test("validates persisted component arithmetic", () => {
    const record = cost()
    expect(() =>
      normalizeAiModelCallCostRecord({
        ...record,
        money: { ...record.money, amountNanos: "1" },
      })
    ).toThrow("total does not equal")
  })

  test("matches billed quantities to usage without consulting a catalog", () => {
    const record = normalizeAiModelCallCostRecord(cost())
    expect(aiModelCallCostMatchesUsage(record, usage)).toBe(true)
    expect(
      aiModelCallCostMatchesUsage(
        normalizeAiModelCallCostRecord({
          ...cost(),
          money: { currency: "USD", amountNanos: "21" },
          components: [
            { ...cost().components[0]!, quantity: "10", chargeAmountNanos: "10" },
            ...cost().components.slice(1),
          ],
        }),
        usage
      )
    ).toBe(false)
  })

  test("retains distinct cache-write TTL charges while matching their durable total", () => {
    const cacheUsage: AiModelCallUsageRecord = {
      ...usage,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        uncachedInputTokens: 8,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 2,
        totalTokens: 20,
        reportingStatus: "complete",
      },
    }
    const record = normalizeAiModelCallCostRecord({
      ...cost(),
      priceSource: { ...cost().priceSource, sourceId: "model-rate-card" },
      money: { currency: "USD", amountNanos: "20" },
      components: [
        {
          meter: "tokens.input.uncached",
          quantity: "8",
          rateAmountNanosPerMillion: "1000000",
          chargeAmountNanos: "8",
        },
        {
          meter: "tokens.input.cacheRead",
          quantity: "2",
          rateAmountNanosPerMillion: "1000000",
          chargeAmountNanos: "2",
        },
        {
          meter: "tokens.input.cacheWrite5m",
          quantity: "1",
          rateAmountNanosPerMillion: "1000000",
          chargeAmountNanos: "1",
        },
        {
          meter: "tokens.input.cacheWrite1h",
          quantity: "1",
          rateAmountNanosPerMillion: "1000000",
          chargeAmountNanos: "1",
        },
        {
          meter: "tokens.output.total",
          quantity: "8",
          rateAmountNanosPerMillion: "1000000",
          chargeAmountNanos: "8",
        },
      ],
    })
    if (record.status !== "rated") throw new Error("Expected a rated cost record.")

    expect(record.components.map((component) => component.meter)).toEqual([
      "tokens.input.uncached",
      "tokens.input.cacheRead",
      "tokens.input.cacheWrite5m",
      "tokens.input.cacheWrite1h",
      "tokens.output.total",
    ])
    expect(aiModelCallCostMatchesUsage(record, cacheUsage)).toBe(true)
    expect(
      aiModelCallCostMatchesUsage(
        {
          ...record,
          components: record.components.map((component) =>
            component.meter === "tokens.input.cacheWrite1h"
              ? { ...component, quantity: "0", chargeAmountNanos: "0" }
              : component
          ),
          money: { currency: "USD", amountNanos: "19" },
        },
        cacheUsage
      )
    ).toBe(false)
  })

  test("requires component evidence for model rate-card ratings", () => {
    expect(() =>
      normalizeAiModelCallCostRecord({
        ...cost(),
        priceSource: { ...cost().priceSource, sourceId: "model-rate-card" },
        components: [],
      })
    ).toThrow("requires components")
  })
})
