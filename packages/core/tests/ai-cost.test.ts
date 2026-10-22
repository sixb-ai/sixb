import { describe, expect, test } from "bun:test"
import { type ModelRateCard, type ModelUsage, rateModelCall } from "../src/models"
import type { AiModelCallCostRecord } from "../src/storage/ai-cost"
import { aiModelCallCostDetails, parseAiModelCallCostDetails } from "../src/storage/ai-cost/codec"
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
  test.each([
    {
      name: "a total that differs from its components",
      record: { ...cost(), money: { currency: "USD" as const, amountNanos: "1" } },
      error: "total does not equal",
    },
    {
      name: "a model rate-card rating without component evidence",
      record: {
        ...cost(),
        priceSource: { ...cost().priceSource, sourceId: "model-rate-card" },
        components: [],
      },
      error: "requires components",
    },
  ])("rejects $name", ({ record, error }) => {
    expect(() => normalizeAiModelCallCostRecord(record)).toThrow(error)
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

  test.each([
    {
      name: "a multimodal model's per-image charge",
      usage: { inputTokens: 14, outputTokens: 1120, imageOutputTokens: 1120, outputImages: 1 },
      rateCard: { currency: "USD", input: "0.25", output: "1.5", images: "0.034" },
    },
    {
      name: "an image endpoint call",
      usage: { outputImages: 2 },
      rateCard: { currency: "USD", images: "0.008" },
    },
    {
      name: "a character-priced speech call",
      usage: { inputCharacters: 12, audioDurationMs: 1160 },
      rateCard: { currency: "USD", characters: "15" },
    },
    {
      name: "audio output tokens beside text",
      usage: { inputTokens: 3, outputTokens: 40, textOutputTokens: 11, audioOutputTokens: 29 },
      rateCard: { currency: "USD", input: "0.5", output: "6", audioOutput: "12" },
    },
  ] satisfies {
    name: string
    usage: ModelUsage
    rateCard: ModelRateCard
  }[])("matches $name to its usage", ({ usage: callUsage, rateCard }) => {
    // Removal proof: drop a meter from UNIT_METERS or a partition from outputComponentsMatchUsage;
    // the recorder would then discard these estimates as inconsistent.
    const estimate = rateModelCall({ usage: callUsage, rateCard })
    if (estimate.status !== "rated") throw new Error(`Expected a rating, got ${estimate.reason}.`)
    const record = normalizeAiModelCallCostRecord({
      ...cost(),
      money: estimate.money,
      components: estimate.components,
    })
    const recorded = { ...usage, usage: { ...callUsage, reportingStatus: "partial" as const } }

    expect(aiModelCallCostMatchesUsage(record, recorded)).toBe(true)
    expect(
      aiModelCallCostMatchesUsage(record, {
        ...recorded,
        usage: {
          ...recorded.usage,
          outputImages: (callUsage.outputImages ?? 0) + 1,
          inputCharacters: (callUsage.inputCharacters ?? 0) + 1,
          outputTokens: (callUsage.outputTokens ?? 0) + 1,
        },
      })
    ).toBe(false)
  })

  test("keeps the price variant through the stored cost details", () => {
    // Removal proof: drop the variant from costComponentsFromUnknown; the stored row loses it.
    const component = {
      meter: "images.output" as const,
      quantity: "1",
      rateAmountNanosPerMillion: "8000000000000",
      chargeAmountNanos: "8000000",
      variant: "768x768",
    }
    const record = normalizeAiModelCallCostRecord({
      ...cost(),
      money: { currency: "USD", amountNanos: "8000000" },
      components: [component],
    })
    const stored = JSON.stringify(aiModelCallCostDetails(record))
    expect(parseAiModelCallCostDetails(stored).components).toEqual([component])
  })
})
