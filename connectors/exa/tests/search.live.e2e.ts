import { describe, expect, test } from "bun:test"
import { exaSearch } from "../src"

// Paid: one real search, under a cent. Never in CI or `test:e2e`; run it by hand with SIXB_LIVE=1
// and EXA_API_KEY set.
const apiKey = process.env.EXA_API_KEY
const enabled = process.env.SIXB_LIVE === "1" && Boolean(apiKey)

describe.skipIf(!enabled)("Exa web search (live)", () => {
  test("returns hits and the cost Exa charged", async () => {
    const model = exaSearch({ apiKey: apiKey ?? "" })

    const result = await model.search({ query: "Bun 1.4 release notes", maxResults: 3 })

    expect(result.results.length).toBeGreaterThan(0)
    for (const hit of result.results) {
      expect(hit.url).toMatch(/^https?:\/\//)
      expect(hit.snippet.length).toBeGreaterThan(0)
    }

    const charged = BigInt(result.reportedCost?.money.amountNanos ?? "0")
    const reserved = BigInt(
      model.costEstimator?.estimateReservation?.({ maxResults: 3 })?.amountNanos ?? "0"
    )
    expect(charged).toBeGreaterThan(0n)
    expect(charged).toBeLessThanOrEqual(reserved)

    const [first] = result.results
    console.log(
      `[live] exa: $${Number(charged) / 1e9}, ${result.results.length} hits, first: ${first?.title} <${first?.url}>`
    )
  }, 30_000)
})
