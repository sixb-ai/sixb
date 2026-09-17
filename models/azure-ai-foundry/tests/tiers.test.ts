import { expect, test } from "bun:test"
import { foundryEstimator, foundryUsage } from "../src/accounting"
import { foundryChatEstimator, foundryChatUsage } from "../src/chat-accounting"
import { createAzureAIFoundry } from "./provider-fixture"

// Removal proof: restore flat-only rates() parsing; all valid boundary estimates
// become unpriceable. models.dev generate.ts defines context_over_200k as a legacy
// mirror; tiers carries the actual threshold, which may exceed 200k.
test("prices exact context boundaries and reserves the expensive tier", async () => {
  const cost = {
    input: 1,
    output: 2,
    tiers: [{ input: 3, output: 4, tier: { type: "context", size: 272000 } }],
    context_over_200k: { input: 3, output: 4 },
  }
  const p = createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: "key",
    catalog: {
      fetch: async () =>
        Response.json({
          azure: { models: { future: { id: "future", modalities: { output: ["text"] }, cost } } },
        }),
    },
  })
  const model = await p("deployment", { identity: { modelName: "future" } }).resolve()
  for (const [inputTokens, inputRate, outputRate] of [
    [272000, "1000000000", "2000000000"],
    [272001, "3000000000", "4000000000"],
  ] as const) {
    const estimate = model.costEstimator.estimate({ usage: { inputTokens, outputTokens: 1 } })
    expect(estimate).toMatchObject({
      status: "rated",
      components: [
        { rateAmountNanosPerMillion: inputRate },
        { rateAmountNanosPerMillion: outputRate },
      ],
    })
  }
  expect(model.costEstimator.estimateReservation?.({ inputTokens: 1, outputTokens: 1 })).toEqual({
    currency: "USD",
    amountNanos: "7000",
  })
})

test("sorts multiple tiers, prices caches, and rejects ambiguous or unsupported dimensions", async () => {
  const tier = (size: number, cache_read = 0.2) => ({
    input: 3,
    output: 4,
    cache_read,
    tier: { type: "context", size },
  })
  const costs = [
    { input: 1, output: 2, cache_read: 0.1, tiers: [tier(20, 0.3), tier(10)] },
    { input: 1, output: 2, tiers: [tier(10)] },
    { input: 1, output: 2, cache_read: 0.1, tiers: [tier(10), tier(10)] },
    {
      input: 1,
      output: 2,
      cache_read: 0.1,
      tiers: [tier(200000)],
      context_over_200k: { input: 99, output: 4, cache_read: 0.2 },
    },
    {
      input: 1,
      output: 2,
      tiers: [{ input: 3, output: 4, reasoning: 5, tier: { type: "context", size: 10 } }],
    },
    { input: 1, output: 2, tiers: [{ input: 3, output: 4, tier: { type: "output", size: 10 } }] },
    { input: 1, output: 2, tiers: [{ input: 3, output: 4, tier: { size: -1 } }] },
    { input: 1, output: 2, tiers: [{ input: 3, output: 4, tier: { size: 1.5 } }] },
  ]
  for (const [index, cost] of costs.entries()) {
    const p = createAzureAIFoundry({
      endpoint: "https://example.test/api/projects/test",
      apiKey: "key",
      catalog: {
        fetch: async () =>
          Response.json({
            azure: { models: { future: { id: "future", modalities: { output: ["text"] }, cost } } },
          }),
      },
    })
    const model = await p("deployment", { identity: { modelName: "future" } }).resolve()
    const estimate = model.costEstimator.estimate({
      usage: { inputTokens: 21, uncachedInputTokens: 1, cacheReadInputTokens: 20, outputTokens: 1 },
    })
    if (index === 0)
      expect(estimate).toMatchObject({ status: "rated", money: { amountNanos: "13000" } })
    else expect(estimate.status).toBe("unpriceable")
  }
})

test("cache-write tiers and reservations stay pinned across catalog refresh", async () => {
  let high = 4
  const p = createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: "key",
    catalog: {
      fetch: async () =>
        Response.json({
          azure: {
            models: {
              future: {
                id: "future",
                modalities: { output: ["text"] },
                cost: {
                  input: 1,
                  output: 2,
                  cache_read: 0.1,
                  cache_write: 2,
                  tiers: [
                    {
                      input: high,
                      output: high,
                      cache_read: high,
                      cache_write: high,
                      tier: { size: 10 },
                    },
                  ],
                },
              },
            },
          },
        }),
    },
  })
  const binding = p("deployment", { identity: { modelName: "future" } })
  const original = await binding.resolve()
  high = 8
  await p.catalog.refresh()
  const refreshed = await binding.resolve()
  const usage = {
    inputTokens: 11,
    uncachedInputTokens: 1,
    cacheReadInputTokens: 5,
    cacheWriteInputTokens: 5,
    outputTokens: 1,
  }
  expect(original.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "48000" },
  })
  expect(refreshed.costEstimator.estimate({ usage })).toMatchObject({
    money: { amountNanos: "96000" },
  })
  expect(
    original.costEstimator.estimateReservation?.({ inputTokens: 11, outputTokens: 1 })
  ).toEqual({ currency: "USD", amountNanos: "48000" })
})

// Removal proof: omit cacheWriteInputTokens for explicit zero wire meters; both
// adapters become unpriceable with a catalog that includes a cache-write price.
test("explicit zero cache writes are usable with catalog write rates; absent counts stay unknown", () => {
  const card = {
    currency: "USD",
    unit: "million-tokens",
    input: "1",
    output: "2",
    cacheReadInput: "0.1",
    cacheWriteInput: "3",
  } as const
  for (const writes of [undefined, 0, 1, null]) {
    const details = {
      cached_tokens: 0,
      ...(writes === undefined ? {} : { cache_write_tokens: writes }),
    }
    const responses = foundryUsage(
      { input_tokens: 10, output_tokens: 1, input_tokens_details: details },
      false
    )
    const chat = foundryChatUsage(
      { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: details },
      false
    )
    for (const estimate of [
      foundryEstimator(card, undefined).estimate({ usage: responses }),
      foundryChatEstimator(card, undefined).estimate({ usage: chat }),
    ]) {
      if (writes === 0)
        expect(estimate).toMatchObject({ status: "rated", money: { amountNanos: "12000" } })
      else expect(estimate.status).toBe("unpriceable")
    }
  }
})
