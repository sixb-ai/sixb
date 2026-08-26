import { describe, expect, test } from "bun:test"
import { normalizeAiModelCallCostRecord } from "@sixb/core/internal/ai-cost-storage-provider"
import type { AiModelCallUsageRecord } from "@sixb/core/storage"
import {
  MODELS_DEV_CATALOG_SOURCE,
  rateAiModelCall,
  resolveModelsDevBillingIdentity,
} from "../src/ai-pricing/models-dev"

function usage(overrides: Partial<AiModelCallUsageRecord> = {}): AiModelCallUsageRecord {
  return {
    id: "usage_1",
    projectId: "project_1",
    executionId: "execution_1",
    attempt: 1,
    callId: "call_1",
    requesterGroupIds: [],
    providerId: "anthropic.messages",
    requestedModelId: "claude-opus-4-8",
    responseId: "response_1",
    usage: {
      inputTokens: 1_913,
      outputTokens: 247,
      uncachedInputTokens: 1_913,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      reportingStatus: "complete",
      totalTokens: 2_160,
    },
    occurredAt: new Date("2026-08-25T00:00:00.000Z"),
    recordedAt: new Date("2026-08-25T00:00:00.100Z"),
    ...overrides,
  }
}

function rate(
  record = usage(),
  input: Parameters<typeof rateAiModelCall>[0] = {
    usage: record,
    ratedAt: new Date("2026-08-25T00:00:01.000Z"),
  }
) {
  return rateAiModelCall({ ...input, usage: record })
}

describe("Models.dev AI cost rating", () => {
  test("rates the exact direct Anthropic AI SDK model identity", () => {
    const result = rate()
    expect(result).toMatchObject({
      status: "rated",
      billingIdentity: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      money: { currency: "USD", amountNanos: "15740000" },
      priceSource: {
        sourceId: "models.dev",
        sourceEntryId: "anthropic/claude-opus-4-8",
        sourceVersion: MODELS_DEV_CATALOG_SOURCE.sourceVersion,
      },
    })
    if (result.status !== "rated") throw new Error("Expected a rated result")
    expect(result.components).toEqual([
      {
        meter: "tokens.input.uncached",
        quantity: "1913",
        rateAmountNanosPerMillion: "5000000000",
        chargeAmountNanos: "9565000",
      },
      {
        meter: "tokens.input.cacheRead",
        quantity: "0",
        rateAmountNanosPerMillion: "500000000",
        chargeAmountNanos: "0",
      },
      {
        meter: "tokens.input.cacheWrite",
        quantity: "0",
        rateAmountNanosPerMillion: "6250000000",
        chargeAmountNanos: "0",
      },
      {
        meter: "tokens.output.total",
        quantity: "247",
        rateAmountNanosPerMillion: "25000000000",
        chargeAmountNanos: "6175000",
      },
    ])
  })

  test("keeps Gateway and direct-provider identities separate", () => {
    const gatewayUsage = usage({
      providerId: "gateway",
      requestedModelId: "anthropic/claude-opus-4.8",
    })
    expect(resolveModelsDevBillingIdentity(gatewayUsage)).toEqual({
      providerId: "vercel",
      modelId: "anthropic/claude-opus-4.8",
    })
    expect(rate(gatewayUsage)).toMatchObject({
      status: "rated",
      billingIdentity: {
        providerId: "vercel",
        modelId: "anthropic/claude-opus-4.8",
      },
    })
  })

  test("prices a requested Gateway route instead of its underlying response model", () => {
    const gatewayUsage = usage({
      providerId: "gateway",
      requestedModelId: "poolside/laguna-s-2.1-free",
      responseModelId: "poolside/laguna-s-2.1",
      usage: {
        inputTokens: 1_044,
        outputTokens: 40,
        uncachedInputTokens: 1_044,
        cacheReadInputTokens: 0,
        reportingStatus: "complete",
        totalTokens: 1_084,
      },
      rawUsage: {
        providerMetadata: {
          gateway: {
            routing: { canonicalSlug: "poolside/laguna-s-2.1-free" },
            cost: "0",
          },
        },
      },
    })

    expect(resolveModelsDevBillingIdentity(gatewayUsage)).toEqual({
      providerId: "vercel",
      modelId: "poolside/laguna-s-2.1-free",
    })
    expect(rate(gatewayUsage)).toMatchObject({
      status: "rated",
      billingIdentity: {
        providerId: "vercel",
        modelId: "poolside/laguna-s-2.1-free",
      },
      money: { currency: "USD", amountNanos: "0" },
      priceSource: {
        sourceEntryId: "vercel/poolside/laguna-s-2.1-free",
      },
    })
  })

  test("prefers an exact requested Gateway entry over a differently named canonical route", () => {
    const gatewayUsage = usage({
      providerId: "gateway",
      requestedModelId: "spacexai/grok-4.6",
      responseModelId: "grok-4.6",
      usage: {
        inputTokens: 1_726,
        outputTokens: 401,
        uncachedInputTokens: 1_598,
        cacheReadInputTokens: 128,
        reportingStatus: "complete",
        totalTokens: 2_127,
      },
      rawUsage: {
        providerMetadata: {
          gateway: {
            routing: { canonicalSlug: "xai/grok-4.6", finalProvider: "xai" },
          },
        },
      },
    })

    expect(resolveModelsDevBillingIdentity(gatewayUsage)).toEqual({
      providerId: "vercel",
      modelId: "spacexai/grok-4.6",
    })
    expect(rate(gatewayUsage)).toMatchObject({
      status: "rated",
      billingIdentity: { providerId: "vercel", modelId: "spacexai/grok-4.6" },
      money: { currency: "USD", amountNanos: "5666000" },
      priceSource: { sourceEntryId: "vercel/spacexai/grok-4.6" },
    })
  })

  test("uses an exact canonical Gateway entry when the requested route is absent", () => {
    expect(
      resolveModelsDevBillingIdentity({
        providerId: "gateway",
        requestedModelId: "legacy/laguna-free",
        responseModelId: "poolside/laguna-s-2.1",
        rawUsage: {
          providerMetadata: {
            gateway: {
              routing: { canonicalSlug: "poolside/laguna-s-2.1-free" },
            },
          },
        },
      })
    ).toEqual({ providerId: "vercel", modelId: "poolside/laguna-s-2.1-free" })
  })

  test("uses the requested Gateway route when canonical routing metadata is unavailable", () => {
    expect(
      resolveModelsDevBillingIdentity({
        providerId: "gateway",
        requestedModelId: "poolside/laguna-s-2.1-free",
        responseModelId: "poolside/laguna-s-2.1",
      })
    ).toEqual({ providerId: "vercel", modelId: "poolside/laguna-s-2.1-free" })
  })

  test("maps exact catalog providers and reviewed AI SDK namespaces", () => {
    expect(
      resolveModelsDevBillingIdentity({ providerId: "groq", requestedModelId: "model" })
    ).toEqual({ providerId: "groq", modelId: "model" })
    expect(
      resolveModelsDevBillingIdentity({ providerId: "groq.chat", requestedModelId: "model" })
    ).toEqual({ providerId: "groq", modelId: "model" })
    expect(
      resolveModelsDevBillingIdentity({ providerId: "wafer.ai.chat", requestedModelId: "model" })
    ).toEqual({ providerId: "wafer.ai", modelId: "model" })
  })

  test("uses an exact cataloged response model when a provider resolves an alias", () => {
    expect(
      resolveModelsDevBillingIdentity({
        providerId: "anthropic.messages",
        requestedModelId: "claude-sonnet-4-5",
        responseModelId: "claude-sonnet-4-5-20250929",
      })
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" })
  })

  test("fails closed when a direct provider reports an unknown response model", () => {
    const record = usage({ responseModelId: "claude-opus-private-v2" })
    expect(resolveModelsDevBillingIdentity(record)).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-private-v2",
    })
    expect(rate(record)).toMatchObject({
      status: "unpriceable",
      reason: "missingCatalogEntry",
      billingIdentity: {
        providerId: "anthropic",
        modelId: "claude-opus-private-v2",
      },
    })
  })

  test("does not coerce custom provider prefixes into catalog identities", () => {
    expect(
      resolveModelsDevBillingIdentity({
        providerId: "openai.private-proxy",
        requestedModelId: "gpt-5",
      })
    ).toBeUndefined()
    expect(
      rate(usage({ providerId: "openai.private-proxy", requestedModelId: "gpt-5" }))
    ).toMatchObject({ status: "unpriceable", reason: "missingBillingIdentity" })
  })

  test("selects named catalog modes from observed pricing context", () => {
    const result = rate(usage(), {
      usage: usage(),
      pricingContext: { mode: "fast" },
      ratedAt: new Date("2026-08-25T00:00:01.000Z"),
    })
    expect(result).toMatchObject({
      status: "rated",
      money: { amountNanos: "31480000" },
    })
  })

  test("selects Models.dev long-context tiers without a generic schedule DSL", () => {
    const longContext = usage({
      providerId: "google.generative-ai",
      requestedModelId: "gemini-2.5-computer-use-preview-10-2025",
      usage: {
        inputTokens: 200_001,
        outputTokens: 1,
        reportingStatus: "complete",
        totalTokens: 200_002,
      },
    })
    expect(rate(longContext)).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "500017500" },
      components: [
        { meter: "tokens.input.total", rateAmountNanosPerMillion: "2500000000" },
        { meter: "tokens.output.total", rateAmountNanosPerMillion: "15000000000" },
      ],
    })
  })

  test("fails closed for unknown identities and entries", () => {
    expect(rate(usage({ providerId: "custom", requestedModelId: "model" }))).toMatchObject({
      status: "unpriceable",
      reason: "missingBillingIdentity",
    })
    expect(rate(usage({ requestedModelId: "claude-opus-nearest-ish" }))).toMatchObject({
      status: "unpriceable",
      reason: "missingCatalogEntry",
      billingIdentity: { providerId: "anthropic", modelId: "claude-opus-nearest-ish" },
    })
  })

  test("fails closed when required cache usage is missing or inconsistent", () => {
    const missing = usage({
      usage: {
        inputTokens: 10,
        outputTokens: 1,
        reportingStatus: "complete",
        totalTokens: 11,
      },
    })
    expect(rate(missing)).toMatchObject({
      status: "unpriceable",
      reason: "missingUsageMeter",
      missingMeters: ["tokens.input.uncached", "tokens.input.cacheRead", "tokens.input.cacheWrite"],
    })

    const inconsistent = usage({
      usage: {
        inputTokens: 10,
        outputTokens: 1,
        uncachedInputTokens: 8,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 0,
        reportingStatus: "complete",
        totalTokens: 11,
      },
    })
    expect(rate(inconsistent)).toMatchObject({
      status: "unpriceable",
      reason: "invalidUsageForFormula",
    })
  })

  test("rejects unsupported pricing dimensions instead of applying base rates", () => {
    for (const pricingContext of [
      { batch: true },
      { routedProviderId: "alternate-provider" },
      { deploymentId: "production" },
      { deploymentId: "production", mode: "fast" },
    ]) {
      expect(
        rateAiModelCall({
          usage: usage(),
          pricingContext,
          ratedAt: new Date("2026-08-25T00:00:01.000Z"),
        })
      ).toMatchObject({ status: "unpriceable", reason: "unsupportedPricingDimension" })
    }
  })

  test("validates persisted component arithmetic", () => {
    const result = rate()
    if (result.status !== "rated") throw new Error("Expected rated fixture")
    expect(() =>
      normalizeAiModelCallCostRecord({
        ...result,
        money: { ...result.money, amountNanos: "1" },
      })
    ).toThrow("total does not equal")
  })
})
