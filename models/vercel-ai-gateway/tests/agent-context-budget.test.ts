import { expect, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  prepareAgentModel,
  resolveAgentContextTarget,
} from "../../../packages/agent/src/context-budget"
import { createVercelGateway } from "../src"

// Windows and prices as `GET https://ai-gateway.vercel.sh/v1/models` listed them on 2026-11-01.
// Haiku 5.5's ×5 tier above 100,000 prompt tokens matches Anthropic's pricing page.
const tiers = (low: string, high: string, from: number) => [
  { cost: low, min: 0, max: from },
  { cost: high, min: from },
]
const CATALOG = [
  {
    id: "anthropic/claude-haiku-5.5",
    context_window: 1_000_000,
    max_tokens: 128_000,
    pricing: {
      input: "0.0000001",
      input_tiers: tiers("0.0000001", "0.0000005", 100_001),
      output: "0.0000005",
      output_tiers: tiers("0.0000005", "0.0000025", 100_001),
      input_cache_read: "0.00000001",
      input_cache_read_tiers: tiers("0.00000001", "0.00000005", 100_001),
      input_cache_write: "0.000000125",
      input_cache_write_tiers: tiers("0.000000125", "0.000000625", 100_001),
    },
  },
  {
    id: "anthropic/claude-opus-5.5",
    context_window: 1_000_000,
    max_tokens: 128_000,
    pricing: {
      input: "0.000004",
      output: "0.00002",
      input_cache_read: "0.0000002",
      input_cache_write: "0.000005",
    },
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    context_window: 1_000_000,
    max_tokens: 64_000,
    pricing: {
      input: "0.000003",
      input_tiers: tiers("0.000003", "0.000006", 200_001),
      output: "0.000015",
      output_tiers: tiers("0.000015", "0.0000225", 200_001),
      input_cache_read: "0.0000003",
      input_cache_read_tiers: tiers("0.0000003", "0.0000006", 200_001),
      input_cache_write: "0.00000375",
      input_cache_write_tiers: tiers("0.00000375", "0.0000075", 200_001),
    },
  },
  {
    id: "google/gemini-2.5-pro",
    context_window: 1_048_576,
    max_tokens: 65_535,
    pricing: {
      input: "0.00000125",
      input_tiers: tiers("0.00000125", "0.0000025", 200_001),
      output: "0.00001",
      output_tiers: tiers("0.00001", "0.000015", 200_001),
      input_cache_read: "0.000000125",
      input_cache_read_tiers: tiers("0.000000125", "0.00000025", 200_001),
    },
  },
  {
    id: "google/gemini-3-flash",
    context_window: 1_000_000,
    max_tokens: 65_000,
    pricing: {
      input: "0.0000005",
      input_tiers: tiers("0.0000005", "0.0000005", 200_001),
      output: "0.000003",
      output_tiers: tiers("0.000003", "0.000003", 200_001),
      input_cache_read: "0.00000005",
      input_cache_read_tiers: tiers("0.00000005", "0.00000005", 200_001),
    },
  },
].map((entry) => ({ ...entry, type: "language", tags: ["tool-use"] }))

const gateway = createVercelGateway({
  fetch: async () => Response.json({ object: "list", data: CATALOG }),
})

async function target(modelId: string, expectedRemainingCalls?: number) {
  const { budget } = prepareAgentModel({ model: await resolveLanguageModel(gateway(modelId)) })
  return resolveAgentContextTarget(budget, { expectedRemainingCalls })
}

// Removal proof: drop the tier from resolveAgentContextTarget (always the hard limit); Haiku 5.5
// then lets a fresh thread grow to 983,616 tokens at five times the price past 100,000.
test.each([
  {
    thread: "fresh",
    modelId: "anthropic/claude-haiku-5.5",
    tokens: 100_000,
    limit: "price-tier",
    priceRatio: 5,
    breakEvenCalls: 4.91,
  },
  { modelId: "anthropic/claude-opus-5.5", thread: "fresh", tokens: 983_616, limit: "window" },
  {
    thread: "fresh",
    modelId: "anthropic/claude-sonnet-4.5",
    tokens: 983_616,
    limit: "window",
    priceRatio: 2,
    breakEvenCalls: 13.96,
  },
  {
    modelId: "anthropic/claude-sonnet-4.5",
    thread: "18 calls to go",
    calls: 18,
    tokens: 200_000,
    limit: "price-tier",
    priceRatio: 2,
    breakEvenCalls: 13.96,
  },
  {
    thread: "fresh",
    modelId: "google/gemini-2.5-pro",
    tokens: 1_032_192,
    limit: "window",
    priceRatio: 2,
    breakEvenCalls: 13.77,
  },
  {
    modelId: "google/gemini-2.5-pro",
    thread: "14 calls to go",
    calls: 14,
    tokens: 200_000,
    limit: "price-tier",
    priceRatio: 2,
    breakEvenCalls: 13.77,
  },
  { modelId: "google/gemini-3-flash", thread: "fresh", tokens: 983_616, limit: "window" },
])("$modelId keeps under $tokens tokens ($thread)", async (expected) => {
  const resolved = await target(expected.modelId, expected.calls)

  expect(resolved).toMatchObject({ tokens: expected.tokens, limit: expected.limit })
  if (expected.breakEvenCalls === undefined) {
    expect(resolved.tier).toBeUndefined()
  } else {
    expect(resolved.tier?.priceRatio).toBeCloseTo(expected.priceRatio, 6)
    expect(resolved.tier?.breakEvenCalls).toBeCloseTo(expected.breakEvenCalls, 2)
  }
})
