import { describe, expect, test } from "bun:test"
import { createVercelGateway } from "../src"

// Paid: one real search per engine, about two cents in all. Never in CI or `test:e2e`; run it by
// hand with SIXB_LIVE=1 and AI_GATEWAY_API_KEY set.
const enabled = process.env.SIXB_LIVE === "1" && Boolean(process.env.AI_GATEWAY_API_KEY)

describe.skipIf(!enabled)("Gateway web search (live)", () => {
  for (const engine of ["perplexity", "exa", "parallel"] as const) {
    test(`${engine} returns hits and the cost Gateway charged`, async () => {
      const model = createVercelGateway().webSearch(engine)

      const result = await model.search({ query: "Bun 1.4 release notes", maxResults: 3 })

      expect(result.results.length).toBeGreaterThan(0)
      for (const hit of result.results) {
        expect(hit.url).toMatch(/^https?:\/\//)
        expect(typeof hit.title).toBe("string")
      }

      const charged = BigInt(result.reportedCost?.money.amountNanos ?? "0")
      const reserved = BigInt(
        model.costEstimator?.estimateReservation?.({ maxResults: 3 })?.amountNanos ?? "0"
      )
      expect(charged).toBeGreaterThan(0n)
      expect(charged).toBeLessThanOrEqual(reserved)

      const [first] = result.results
      console.log(
        `[live] ${engine}: $${Number(charged) / 1e9}, ${result.results.length} hits, first: ${first?.title} <${first?.url}>`
      )
    }, 30_000)
  }
})
