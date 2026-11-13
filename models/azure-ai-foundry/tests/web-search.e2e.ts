import { afterAll, expect, test } from "bun:test"
import { UnsupportedModelFeatureError } from "@sixb/core/models"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

// Opt-in: billable searches, at most 3, serial and without retries. Each one is a Grounding with
// Bing search, billed by Microsoft outside the Azure Retail Prices API, plus about 8,000 input
// tokens of the deployment that runs it (under USD 0.002 with gpt-5.4-nano).
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const deployment = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const speech = env.AZURE_FOUNDRY_SPEECH_DEPLOYMENT
const live = () => test.skipIf(!enabled || !endpoint || !apiKey || !deployment)

let searches = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.endsWith("/responses")) {
    if (++searches > 3) throw new Error("Live test search allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

afterAll(() => {
  if (searches) console.info("[FoundryWebSearchLive]", JSON.stringify({ searches, report }))
})

live()(
  "returns titled, snippeted hits, and keeps to allowed domains",
  async () => {
    const model = await foundry().webSearch(deployment!).resolve()

    const started = performance.now()
    const open = await model.search({
      query: "chiller low refrigerant pressure trip causes",
      maxResults: 5,
    })
    report.push({ ms: Math.round(performance.now() - started), open })
    expect(open.results.length).toBeGreaterThan(0)
    expect(open.results.length).toBeLessThanOrEqual(5)
    for (const hit of open.results) {
      expect(hit.url).toMatch(/^https?:\/\//)
      expect(hit.title.length).toBeGreaterThan(0)
    }
    expect(open.results.some((hit) => hit.snippet.length > 20)).toBe(true)
    expect(open.usage?.inputTokens).toBeGreaterThan(0)

    // An allowed `*.` rule widens to its host for Azure; a blocked host is filtered by Azure.
    const filtered = await model.search({
      query: "Azure Retail Prices REST API",
      maxResults: 5,
      allowedDomains: ["*.microsoft.com"],
      blockedDomains: ["learn.microsoft.com"],
    })
    report.push({ filtered: filtered.results.map((hit) => hit.url) })
    expect(filtered.results.length).toBeGreaterThan(0)
    for (const hit of filtered.results) {
      expect(new URL(hit.url).hostname).toMatch(/(^|\.)microsoft\.com$/)
      expect(new URL(hit.url).hostname).not.toBe("learn.microsoft.com")
    }
  },
  60_000
)

live()(
  "the wrong deployment kind and the timeout surface as errors",
  async () => {
    const provider = foundry()
    if (speech) {
      const wrong = await provider
        .webSearch(speech)
        .resolve()
        .catch((error: unknown) => error)
      expect(wrong).toBeInstanceOf(UnsupportedModelFeatureError)
    }
    const timed = await provider.webSearch(deployment!, { timeoutMs: 1 }).resolve()
    const timeout = await timed.search({ query: "x", maxResults: 1 }).catch((e: unknown) => e)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
  },
  30_000
)
