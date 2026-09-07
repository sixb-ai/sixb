import { expect, test } from "bun:test"
import type { JsonObject } from "@sixb/core/models"
import { createAnthropic } from "../src"
import { anthropicRateCard } from "../src/model-details"

// Regression proof: restore the family regexes and derived cache multipliers in model-details.
test("prices cache reads explicitly for each covered version", () => {
  expect(anthropicRateCard("claude-fable-5-1", undefined)?.cacheReadInput).toBe("0.25")
  expect(anthropicRateCard("claude-mythos-5-1", undefined)?.cacheReadInput).toBe("0.25")
  expect(anthropicRateCard("claude-fable-5", undefined)?.cacheReadInput).toBe("1")
  const model = createAnthropic()("claude-fable-5-1")
  expect(
    model.costEstimator?.estimate({
      usage: {
        inputTokens: 1_000_000,
        uncachedInputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 0,
      },
    })
  ).toMatchObject({ status: "rated", money: { amountNanos: "250000000" } })
})

test("applies residency to explicit rates, including the special cache price", () => {
  expect(anthropicRateCard("claude-fable-5-1", { inference_geo: "us" })).toEqual({
    currency: "USD",
    unit: "million-tokens",
    input: "11",
    output: "55",
    cacheReadInput: "0.275",
    cacheWriteInput5m: "13.75",
    cacheWriteInput1h: "22",
  })
  expect(anthropicRateCard("claude-opus-5", { speed: "fast", inference_geo: "us" })).toEqual({
    currency: "USD",
    unit: "million-tokens",
    input: "11",
    output: "55",
    cacheReadInput: "1.1",
    cacheWriteInput5m: "13.75",
    cacheWriteInput1h: "22",
  })
})

test.each([
  "claude-fable-5-2",
  "claude-opus-5-99",
  "claude-sonnet-4-99",
  "claude-sonnet-4-6-20990101",
  "custom/claude-opus-5",
  "toString",
])("does not guess a tariff for %s", (modelId) => {
  expect(anthropicRateCard(modelId, undefined)).toBeUndefined()
})

const uncoveredRequests: JsonObject[] = [
  { service_tier: "priority" },
  { speed: "future-mode" },
  { inference_geo: "eu" },
  { unknown_billing_option: true },
]
test.each(uncoveredRequests)("declines uncovered request dimensions (%j)", (request) => {
  expect(anthropicRateCard("claude-opus-5", request)).toBeUndefined()
})

test("does not extrapolate fast or residency pricing to unsupported versions", () => {
  expect(anthropicRateCard("claude-sonnet-5", { speed: "fast" })).toBeUndefined()
  expect(anthropicRateCard("claude-opus-4-5", { inference_geo: "us" })).toBeUndefined()
})

test("keeps inference usable without pricing or a catalog request", async () => {
  let calls = 0
  const model = createAnthropic({
    fetch: async (url) => {
      expect(String(url)).toEndWith("/messages")
      calls += 1
      const events = [
        {
          type: "message_start",
          message: {
            id: "unknown-price",
            model: "claude-fable-5-2",
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: { "content-type": "text/event-stream" },
        }
      )
    },
  })("claude-fable-5-2")
  const response = await model.stream({
    callId: "unknown-price",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  })
  for await (const _event of response.events) {
    /* Drain the mocked stream. */
  }
  expect(calls).toBe(1)
  expect(
    model.costEstimator?.estimate({
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  ).toMatchObject({ status: "unpriceable" })
})
