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
  test("validates reported money and provenance without requiring complete token meters", () => {
    const report = {
      projectId: usage.projectId,
      usageRecordId: usage.id,
      status: "reported",
      billingIdentity: { providerId: usage.providerId, modelId: usage.requestedModelId },
      reportSource: { providerId: usage.providerId, responseId: "report_1" },
      pricingContext: {},
      ratedAt: usage.occurredAt,
      money: { currency: "USD", amountNanos: "0" },
    } as const satisfies AiModelCallCostRecord
    const normalized = normalizeAiModelCallCostRecord(report)
    expect(normalized).toEqual(report)
    expect(normalized.ratedAt).not.toBe(report.ratedAt)
    expect(
      aiModelCallCostMatchesUsage(normalized, {
        ...usage,
        usage: { reportingStatus: "unavailable" },
      })
    ).toBe(true)
    expect(() =>
      normalizeAiModelCallCostRecord({
        ...report,
        reportSource: { ...report.reportSource, providerId: "wrong" },
      })
    ).toThrow("does not match")
    for (const amountNanos of ["-1", "1.1", "9223372036854775808"]) {
      expect(() =>
        normalizeAiModelCallCostRecord({
          ...report,
          money: { currency: "USD", amountNanos },
        })
      ).toThrow()
    }
  })
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
})
