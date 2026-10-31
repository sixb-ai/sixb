import { expect, test } from "bun:test"
import { type JsonObject, rateModelCall } from "@sixb/core/models"
import { modelsDevRateCard } from "@sixb/model-protocols/models-dev"
import { createAnthropic } from "../src"
import { anthropicRateCard } from "../src/model-details"

// models.dev cost objects, at Anthropic's published prices.
const opus5 = modelsDevRateCard({ input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 })
const opus55 = modelsDevRateCard({ input: 4, output: 20, cache_read: 0.2, cache_write: 5 })
const fable51 = modelsDevRateCard({ input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 })
const haiku55 = modelsDevRateCard({
  input: 0.1,
  output: 0.5,
  cache_read: 0.01,
  cache_write: 0.125,
  tiers: [
    {
      input: 0.5,
      output: 2.5,
      cache_read: 0.05,
      cache_write: 0.625,
      tier: { type: "context", size: 100_000 },
    },
  ],
})

test("keeps models.dev prices and derives one-hour cache writes from input", () => {
  expect(anthropicRateCard("claude-opus-5-5", undefined, opus55)).toEqual({
    currency: "USD",
    input: "4",
    output: "20",
    cacheReadInput: "0.2",
    cacheWriteInput5m: "5",
    cacheWriteInput1h: "8",
  })
})

test("applies residency to every meter, including the special cache price", () => {
  expect(anthropicRateCard("claude-fable-5-1", { inference_geo: "us" }, fable51)).toEqual({
    currency: "USD",
    input: "11",
    output: "55",
    cacheReadInput: "0.275",
    cacheWriteInput5m: "13.75",
    cacheWriteInput1h: "22",
  })
  expect(anthropicRateCard("claude-opus-5", { speed: "fast", inference_geo: "us" }, opus5)).toEqual(
    {
      currency: "USD",
      input: "11",
      output: "55",
      cacheReadInput: "1.1",
      cacheWriteInput5m: "13.75",
      cacheWriteInput1h: "22",
    }
  )
})

test("doubles every meter in fast mode", () => {
  expect(anthropicRateCard("claude-opus-5-5", { speed: "fast" }, opus55)).toEqual({
    currency: "USD",
    input: "8",
    output: "40",
    cacheReadInput: "0.4",
    cacheWriteInput5m: "10",
    cacheWriteInput1h: "16",
  })
})

test("bills every Haiku 5.5 meter higher once a prompt exceeds 100,000 tokens", () => {
  const rateCard = anthropicRateCard("claude-haiku-5-5", undefined, haiku55)
  const cost = (inputTokens: number) =>
    rateModelCall({
      rateCard,
      usage: {
        inputTokens,
        uncachedInputTokens: inputTokens - 50_000,
        cacheReadInputTokens: 50_000,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 1_000,
      },
    })

  // 50,000 × $0.10 + 50,000 × $0.01 + 1,000 × $0.50 per million tokens.
  expect(cost(100_000)).toMatchObject({ status: "rated", money: { amountNanos: "6000000" } })
  // 50,001 × $0.50 + 50,000 × $0.05 + 1,000 × $2.50 per million tokens.
  expect(cost(100_001)).toMatchObject({ status: "rated", money: { amountNanos: "30000500" } })
  expect(rateCard?.cacheWriteInput1h).toEqual({
    default: "0.2",
    tiers: [{ minTokens: 100_001, price: "1" }],
  })
  expect(anthropicRateCard("claude-haiku-5-5", { inference_geo: "us" }, haiku55)?.input).toEqual({
    default: "0.11",
    tiers: [{ minTokens: 100_001, price: "0.55" }],
  })
})

test("does not guess a tariff without models.dev prices", () => {
  expect(anthropicRateCard("claude-opus-5-99", undefined, undefined)).toBeUndefined()
})

const uncoveredRequests: JsonObject[] = [
  { service_tier: "priority" },
  { speed: "future-mode" },
  { inference_geo: "eu" },
]
test.each(uncoveredRequests)("declines uncovered request dimensions (%j)", (request) => {
  expect(anthropicRateCard("claude-opus-5", request, opus5)).toBeUndefined()
})

test("does not extrapolate fast or residency pricing to unsupported versions", () => {
  expect(anthropicRateCard("claude-sonnet-5", { speed: "fast" }, opus5)).toBeUndefined()
  expect(anthropicRateCard("claude-opus-4-7", { speed: "fast" }, opus5)).toBeUndefined()
  for (const modelId of ["claude-opus-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku"]) {
    expect(anthropicRateCard(modelId, { inference_geo: "us" }, opus5)).toBeUndefined()
  }
  expect(anthropicRateCard("claude-opus-4-6", { inference_geo: "us" }, opus5)).toBeDefined()
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
