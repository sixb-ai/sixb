import { describe, expect, test } from "bun:test"
import { defineLanguageModel, priceModelCall } from "../src/models"

describe("model definitions and pricing", () => {
  test("rates token, cache, and tier meters in exact nanodollars", () => {
    const cost = priceModelCall({
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        uncachedInputTokens: 750,
        cacheReadInputTokens: 250,
      },
      pricing: {
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
    })
  })

  test("prefers provider-reported billing and never converts unknown pricing to zero", () => {
    expect(
      priceModelCall({
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
    expect(priceModelCall({ usage: { inputTokens: 1, outputTokens: 1 } })).toEqual({
      status: "unpriceable",
      reason: "missing-pricing",
    })
    expect(
      priceModelCall({
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadInputTokens: 11,
        },
        pricing: { currency: "USD", unit: "million-tokens", input: "1", output: "1" },
      })
    ).toEqual({ status: "unpriceable", reason: "inconsistent-usage" })
  })

  test("validates and snapshots inline definitions", () => {
    const capabilities = { reasoning: true }
    const definition = defineLanguageModel({
      kind: "language",
      providerId: "test",
      modelId: "test/model",
      capabilities,
      pricing: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
    })
    capabilities.reasoning = false

    expect(definition.capabilities.reasoning).toBe(true)
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
        pricing: { currency: "USD", unit: "million-tokens", input: "free", output: "2" },
      })
    ).toThrow("nonnegative decimal")
  })
})
