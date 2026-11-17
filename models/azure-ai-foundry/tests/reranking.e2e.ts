import { afterAll, expect, test } from "bun:test"
import { UnsupportedModelFeatureError } from "@sixb/core/models"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

// Opt-in: billable rerank calls, at most 8, serial and without retries. Each one ranks four short
// documents: Rerank v5 bills about 100 input tokens (USD 0.000002), v4 one search (USD 0.002).
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const deployments = [
  env.AZURE_FOUNDRY_RERANK_V5_DEPLOYMENT,
  env.AZURE_FOUNDRY_RERANK_DEPLOYMENT,
].filter((name): name is string => Boolean(name))
const language = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const live = () => test.skipIf(!enabled || !endpoint || !apiKey || deployments.length === 0)

let calls = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.endsWith("/rerank")) {
    if (++calls > 8) throw new Error("Live test rerank allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

const query = "Why did the chiller on line three stop?"
const documents = [
  "Invoices are due within 30 days of receipt.",
  "The line three chiller tripped on low refrigerant pressure at 09:15.",
  "The cafeteria is closed on public holidays.",
  "Refrigerant leaks lower suction pressure and trip compressor safeties.",
]

afterAll(() => {
  if (calls) console.info("[FoundryRerankingLive]", JSON.stringify({ calls, report }))
})

live()(
  "ranks the relevant documents first and reports billed usage",
  async () => {
    const provider = foundry()
    for (const deployment of deployments) {
      const model = await provider.reranking(deployment).resolve()
      const started = performance.now()
      const result = await model.rerank({ query, documents })
      const ms = Math.round(performance.now() - started)
      const cost = model.costEstimator?.estimate({ usage: result.usage! }) ?? "unknown"
      report.push({ deployment, model: model.metadata.modelName, ms, result, cost })

      expect(result.results).toHaveLength(documents.length)
      const ranked = [...result.results].sort((a, b) => b.score - a.score).map((r) => r.index)
      expect(ranked[0]).toBe(1)
      expect(ranked.slice(0, 2)).toContain(3)
      expect(result.providerIds?.responseId).toBeString()
      if (/-v5-/i.test(model.metadata.modelName!)) {
        expect(result.usage?.inputTokens).toBeGreaterThan(0)
        expect(cost).toMatchObject({ status: "rated", money: { currency: "USD" } })
      } else {
        expect(result.usage?.raw).toEqual({ search_units: 1 })
      }
    }
  },
  30_000
)

// Azure enforces no document limit to reject: 1,001 documents rank like 4.
live()(
  "the wrong deployment kind and the timeout surface as errors",
  async () => {
    const provider = foundry()
    if (language) {
      const wrong = await provider
        .reranking(language)
        .resolve()
        .catch((error: unknown) => error)
      expect(wrong).toBeInstanceOf(UnsupportedModelFeatureError)
      report.push({ wrong: String(wrong) })
    }

    const timed = await provider.reranking(deployments[0]!, { timeoutMs: 1 }).resolve()
    const timeout = await timed.rerank({ query, documents }).catch((error: unknown) => error)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
  },
  30_000
)
