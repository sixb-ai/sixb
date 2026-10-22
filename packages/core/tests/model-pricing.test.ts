import { describe, expect, test } from "bun:test"
import {
  defineLanguageModel,
  defineModelRateCard,
  estimateModelReservation,
  modelReasoningSupportIssue,
  rateModelCall,
} from "../src/models"

describe("model definitions and rate cards", () => {
  test("reserves cache writes and expensive tiers before their usage is known", () => {
    // Removal proof: ignore cache/tier prices in estimateModelReservation; this amount decreases.
    expect(
      estimateModelReservation({
        inputTokens: 1000,
        outputTokens: 100,
        rateCard: {
          currency: "USD",
          input: "2",
          cacheReadInput: "0.2",
          cacheWriteInput5m: "2.5",
          cacheWriteInput1h: "4",
          output: { default: "10", tiers: [{ minTokens: 2000, price: "20" }] },
        },
      })
    ).toEqual({ currency: "USD", amountNanos: "6000000" })
    expect(
      estimateModelReservation({
        inputTokens: 1,
        outputTokens: 1,
        rateCard: {
          currency: "USD",
          input: "0.0000011",
          output: "0.0000011",
        },
      })?.amountNanos
    ).toBe("2")
    expect(estimateModelReservation({ inputTokens: 100, outputTokens: 10 })).toBeUndefined()
  })

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
        rateCard: { currency: "USD", input: "1", output: "1" },
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
    expect(() => defineModelRateCard({ currency: "USD", input: "free", output: "2" })).toThrow(
      "nonnegative decimal"
    )
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

// Prices and bills below were measured on Vercel AI Gateway on 2026-10-22.
describe("generated-media pricing", () => {
  const geminiImage = defineModelRateCard({
    currency: "USD",
    input: "0.25",
    output: "1.5",
    images: { default: "0.034", variants: [{ size: "1K", price: "0.034" }] },
  })

  test("bills a multimodal model's images per image instead of as output tokens", () => {
    // Removal proof: drop the per-image coverage in rateOutputTokens; the 1120 image tokens are
    // billed again as text output and the call reads $0.0356835 instead of $0.0340035.
    const usage = {
      inputTokens: 14,
      outputTokens: 1120,
      textOutputTokens: 0,
      imageOutputTokens: 1120,
      outputImages: 1,
    }
    expect(rateModelCall({ usage, rateCard: geminiImage, dimensions: { size: "1K" } })).toEqual({
      status: "rated",
      money: { currency: "USD", amountNanos: "34003500" },
      components: [
        {
          meter: "tokens.input.total",
          quantity: "14",
          rateAmountNanosPerMillion: "250000000",
          chargeAmountNanos: "3500",
        },
        {
          meter: "images.output",
          quantity: "1",
          rateAmountNanosPerMillion: "34000000000000",
          chargeAmountNanos: "34000000",
          variant: "1K",
        },
      ],
    })

    const { imageOutputTokens: _, ...unsplit } = usage
    expect(rateModelCall({ usage: unsplit, rateCard: geminiImage })).toEqual({
      status: "unpriceable",
      reason: "missing-usage",
      missingMeters: ["tokens.output.image"],
    })
    expect(
      rateModelCall({
        usage: { inputTokens: 14, outputTokens: 30, textOutputTokens: 30, outputImages: 0 },
        rateCard: geminiImage,
      })
    ).toMatchObject({ status: "rated", money: { amountNanos: "48500" } })
  })

  test("bills image endpoint models by the variant the request matched", () => {
    const flux = defineModelRateCard({
      currency: "USD",
      images: {
        variants: [
          { size: "768x768", price: "0.008" },
          { size: "1024x1024", price: "0.009" },
        ],
      },
    })
    const usage = { outputImages: 1 }

    expect(rateModelCall({ usage, rateCard: flux, dimensions: { size: "768x768" } })).toEqual({
      status: "rated",
      money: { currency: "USD", amountNanos: "8000000" },
      components: [
        {
          meter: "images.output",
          quantity: "1",
          rateAmountNanosPerMillion: "8000000000000",
          chargeAmountNanos: "8000000",
          variant: "768x768",
        },
      ],
    })
    expect(rateModelCall({ usage, rateCard: flux, dimensions: { size: "512x512" } })).toEqual({
      status: "unpriceable",
      reason: "unsupported-pricing-dimension",
    })
    expect(rateModelCall({ usage: {}, rateCard: flux })).toEqual({
      status: "unpriceable",
      reason: "missing-usage",
      missingMeters: ["images.output"],
    })
    expect(rateModelCall({ usage: { outputImages: 0 }, rateCard: flux })).toMatchObject({
      status: "rated",
      money: { amountNanos: "0" },
    })
  })

  test("bills speech per input character or per audio output token", () => {
    const tts = defineModelRateCard({ currency: "USD", characters: "15" })
    expect(rateModelCall({ usage: { inputCharacters: 12 }, rateCard: tts })).toMatchObject({
      money: { amountNanos: "180000" },
      components: [{ meter: "characters.input", quantity: "12" }],
    })

    const geminiTts = defineModelRateCard({
      currency: "USD",
      input: "0.5",
      output: "6",
      audioOutput: "6",
    })
    expect(
      rateModelCall({
        usage: { inputTokens: 3, outputTokens: 29, audioOutputTokens: 29 },
        rateCard: geminiTts,
      })
    ).toMatchObject({
      money: { amountNanos: "175500" },
      components: [
        { meter: "tokens.input.total", quantity: "3" },
        { meter: "tokens.output.audio", quantity: "29" },
      ],
    })
    expect(
      rateModelCall({ usage: { inputTokens: 3, outputTokens: 29 }, rateCard: geminiTts })
    ).toEqual({
      status: "unpriceable",
      reason: "missing-usage",
      missingMeters: ["tokens.output.audio"],
    })
  })

  test("never prices a count its card does not cover as free", () => {
    expect(
      rateModelCall({
        usage: { outputImages: 2 },
        rateCard: defineModelRateCard({ currency: "USD", characters: "15" }),
      })
    ).toEqual({
      status: "unpriceable",
      reason: "missing-rate-card",
      missingMeters: ["images.output"],
    })
    // Token-priced image models bill their images inside output tokens.
    expect(
      rateModelCall({
        usage: { inputTokens: 10, outputTokens: 100, outputImages: 1 },
        rateCard: { currency: "USD", input: "5", output: "30" },
      })
    ).toMatchObject({ money: { amountNanos: "3050000" } })
  })

  test("reserves every meter the card bills, or nothing", () => {
    const flux = defineModelRateCard({
      currency: "USD",
      images: {
        default: "0.04",
        variants: [
          { size: "1024x1024", price: "0.048" },
          { size: "4096x4096", price: "0.607" },
        ],
      },
    })
    expect(
      estimateModelReservation({
        outputImages: 2,
        dimensions: { size: "1024x1024" },
        rateCard: flux,
      })
    ).toEqual({ currency: "USD", amountNanos: "96000000" })
    // Removal proof: reserve the default for an unmatched size; this reads 80000000.
    expect(estimateModelReservation({ outputImages: 2, rateCard: flux })).toEqual({
      currency: "USD",
      amountNanos: "1214000000",
    })
    // A language model that can return images has no image bound yet: refuse to guess.
    expect(
      estimateModelReservation({ inputTokens: 10, outputTokens: 100, rateCard: geminiImage })
    ).toBeUndefined()
    expect(
      estimateModelReservation({
        inputCharacters: 1_000,
        rateCard: defineModelRateCard({ currency: "USD", characters: "15" }),
      })
    ).toEqual({ currency: "USD", amountNanos: "15000000" })
  })

  test.each([
    { name: "input without output", card: { currency: "USD", input: "1" }, error: "together" },
    { name: "no prices", card: { currency: "USD" }, error: "tokens, images or characters" },
    {
      name: "cache prices without token prices",
      card: { currency: "USD", images: "0.04", cacheReadInput: "1" },
      error: "require input and output",
    },
    {
      name: "image output priced twice",
      card: { currency: "USD", input: "1", output: "1", imageOutput: "30", images: "0.04" },
      error: "not both",
    },
    {
      name: "variants on different dimensions",
      card: {
        currency: "USD",
        images: {
          variants: [
            { size: "1K", price: "0.04" },
            { quality: "high", price: "0.08" },
          ],
        },
      },
      error: "same pricing dimensions",
    },
    {
      name: "duplicate variants",
      card: {
        currency: "USD",
        images: {
          variants: [
            { size: "1K", price: "0.04" },
            { size: "1K", price: "0.05" },
          ],
        },
      },
      error: "distinct",
    },
  ] as const)("rejects a rate card with $name", ({ card, error }) => {
    expect(() => defineModelRateCard(card as Parameters<typeof defineModelRateCard>[0])).toThrow(
      error
    )
  })
})
