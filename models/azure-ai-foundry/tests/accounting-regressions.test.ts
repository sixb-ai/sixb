import { expect, test } from "bun:test"
import type { JsonObject } from "@sixb/core/models"
import { foundryUsage } from "../src/accounting"
import { foundryChatEstimator, foundryChatUsage } from "../src/chat-accounting"

const card = {
  currency: "USD",
  unit: "million-tokens",
  input: "2",
  cacheReadInput: "1",
  output: "10",
} as const

// Captured from Foundry's Fireworks Chat responses. Regression proof: remove the
// output_tokens_details alias handling; the valid captures become unpriceable again.
test("rates consistent Chat reasoning aliases once, including cache hits", () => {
  const raw = {
    prompt_tokens: 173,
    completion_tokens: 44,
    total_tokens: 217,
    prompt_tokens_details: { cached_tokens: 172 },
    completion_tokens_details: { reasoning_tokens: 37 },
    output_tokens_details: { reasoning_tokens: 37 },
  }
  const usage = foundryChatUsage(raw, undefined)
  expect(usage).toMatchObject({
    inputTokens: 173,
    outputTokens: 44,
    uncachedInputTokens: 1,
    cacheReadInputTokens: 172,
    reasoningOutputTokens: 37,
    textOutputTokens: 7,
    raw,
  })
  expect(foundryChatEstimator(card, undefined).estimate({ usage })).toMatchObject({
    status: "rated",
    money: { amountNanos: "614000" },
  })
  const invalidDetails: JsonObject[] = [
    { reasoning_tokens: 38 },
    { reasoning_tokens: 45 },
    { reasoning_tokens: null },
    { reasoning_tokens: "37" },
    { reasoning_tokens: 37, unknown_tokens: 0 },
  ]
  for (const output_tokens_details of invalidDetails) {
    const invalid = { ...raw, output_tokens_details }
    expect(
      foundryChatEstimator(card, undefined).estimate({ usage: { raw: invalid } })
    ).toMatchObject({
      status: "unpriceable",
    })
  }
})

// Regression proof: restore the publisher-only reasoning gate. Positive non-OpenAI
// reports disappear, while zero placeholders must remain unknown by default.
test("preserves positive reasoning reports without interpreting placeholder zeros", () => {
  const aliases: JsonObject[] = [
    { completion_tokens_details: { reasoning_tokens: 3 } },
    { output_tokens_details: { reasoning_tokens: 3 } },
    { reasoning_tokens: 3 },
  ]
  for (const details of aliases) {
    const raw: JsonObject = { prompt_tokens: 10, completion_tokens: 5, ...details }
    expect(foundryChatUsage(raw, undefined).reasoningOutputTokens).toBe(3)
    expect(foundryChatUsage(raw, false).reasoningOutputTokens).toBeUndefined()
  }
  const raw = { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } }
  expect(foundryChatUsage(raw, undefined).reasoningOutputTokens).toBeUndefined()
  expect(foundryChatUsage(raw, true).reasoningOutputTokens).toBe(0)
  expect(
    foundryChatUsage({ ...raw, reasoning_tokens: 2 }, undefined).reasoningOutputTokens
  ).toBeUndefined()
  expect(
    foundryUsage({ output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } }, undefined)
      .reasoningOutputTokens
  ).toBe(3)
})

// Captured GPT-4.1 mini image usage. image_tokens is a subset of prompt_tokens,
// not an additional charge. Regression proof: remove the bounded image partition.
test("rates input image tokens within the prompt total without double counting", () => {
  const raw = {
    prompt_tokens: 121,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 0, image_tokens: 64 },
  }
  expect(
    foundryChatEstimator(card, undefined).estimate({ usage: foundryChatUsage(raw, undefined) })
  ).toMatchObject({ status: "rated", money: { amountNanos: "252000" } })
  for (const image_tokens of [122, -1, null, "64"]) {
    expect(
      foundryChatEstimator(card, undefined).estimate({
        usage: { raw: { ...raw, prompt_tokens_details: { cached_tokens: 0, image_tokens } } },
      })
    ).toMatchObject({ status: "unpriceable" })
  }
})
