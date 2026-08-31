import { describe, expect, test } from "bun:test"
import { defineLanguageModel, modelReasoningSupportIssue, rateModelCall } from "../src/models"

describe("model definitions and rate cards", () => {
  test("rates token, cache, and tier meters in exact nanodollars", () => {
    const cost = rateModelCall({
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        uncachedInputTokens: 750,
        cacheReadInputTokens: 250,
      },
      rateCard: {
        currency: "USD",
        unit: "million-tokens",
        input: "2.5",
        cacheReadInput: "0.5",
        output: {
          default: "10",
          tiers: [{ minTokens: 1_000, price: "20" }],
        },
      },
    })

    expect(cost).toEqual({
      status: "rated",
      money: { currency: "USD", amountNanos: "4000000" },
      components: [
        {
          meter: "tokens.input.uncached",
          quantity: "750",
          rateAmountNanosPerMillion: "2500000000",
          chargeAmountNanos: "1875000",
        },
        {
          meter: "tokens.input.cacheRead",
          quantity: "250",
          rateAmountNanosPerMillion: "500000000",
          chargeAmountNanos: "125000",
        },
        {
          meter: "tokens.output.total",
          quantity: "100",
          rateAmountNanosPerMillion: "20000000000",
          chargeAmountNanos: "2000000",
        },
      ],
    })
  })

  test("prefers provider-reported billing and never converts unknown rates to zero", () => {
    expect(
      rateModelCall({
        usage: {},
        reported: {
          money: { currency: "USD", amountNanos: "12345" },
          providerId: "gateway",
        },
      })
    ).toEqual({
      status: "reported",
      money: { currency: "USD", amountNanos: "12345" },
      providerId: "gateway",
    })
    expect(rateModelCall({ usage: { inputTokens: 1, outputTokens: 1 } })).toEqual({
      status: "unpriceable",
      reason: "missing-rate-card",
    })
    expect(
      rateModelCall({
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadInputTokens: 11,
        },
        rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "1" },
      })
    ).toEqual({ status: "unpriceable", reason: "inconsistent-usage" })
  })

  test("validates and snapshots inline definitions", () => {
    const capabilities = {
      reasoning: { canDisable: true, efforts: ["low", "high"] as const },
    }
    const definition = defineLanguageModel({
      kind: "language",
      providerId: "test",
      modelId: "test/model",
      capabilities,
      rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
    })
    capabilities.reasoning.canDisable = false

    expect(definition.capabilities.reasoning).toEqual({
      canDisable: true,
      efforts: ["low", "high"],
    })
    expect(
      defineLanguageModel({
        kind: "language",
        providerId: "test",
        modelId: "canonical",
        name: undefined,
        capabilities: { reasoning: undefined },
      })
    ).toEqual({
      kind: "language",
      providerId: "test",
      modelId: "canonical",
      capabilities: {},
    })
    expect(() =>
      defineLanguageModel({
        kind: "language",
        providerId: "test",
        modelId: "bad",
        capabilities: {},
        rateCard: { currency: "USD", unit: "million-tokens", input: "free", output: "2" },
      })
    ).toThrow("nonnegative decimal")
  })

  test("validates reasoning preferences against known provider controls", () => {
    const capabilities = {
      canDisable: true,
      efforts: ["low", "high"] as const,
      budgetTokens: { min: 1_024, max: 16_384 },
    }

    expect(modelReasoningSupportIssue(false, "provider-default")).toBeUndefined()
    expect(modelReasoningSupportIssue(false, "low")).toBe("reasoning is not supported")
    expect(modelReasoningSupportIssue(capabilities, "none")).toBeUndefined()
    expect(modelReasoningSupportIssue(capabilities, "medium")).toBe(
      "reasoning effort 'medium' is not supported"
    )
    expect(modelReasoningSupportIssue(capabilities, { budgetTokens: 512 })).toBe(
      "reasoning token budget must be at least 1024"
    )
    expect(modelReasoningSupportIssue(capabilities, { budgetTokens: 32_768 })).toBe(
      "reasoning token budget must not exceed 16384"
    )
  })
})
