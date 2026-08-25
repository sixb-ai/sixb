import { afterEach, describe, expect, test } from "bun:test"
import { sponsoredAccountUrn, sponsoredCampaignUrn } from "../src"
import { createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin ad analytics", () => {
  test("serializes analytics dates, facets, fields, and sorting", async () => {
    const calls = recorder([
      json({
        elements: [
          {
            pivotValues: ["urn:li:sponsoredCampaign:456"],
            impressions: 100,
            costInLocalCurrency: "12.50",
          },
        ],
      }),
    ])
    const client = await createTestClient()

    const rows = await client.adAnalytics.analytics({
      pivot: "CAMPAIGN",
      dateRange: {
        start: { year: 2026, month: 8, day: 1 },
        end: { year: 2026, month: 8, day: 20 },
      },
      timeGranularity: "DAILY",
      fields: ["impressions", "costInLocalCurrency", "pivotValues"],
      accounts: [sponsoredAccountUrn(123)],
      sortBy: { field: "IMPRESSIONS", order: "DESCENDING" },
    })

    const params = new URL(calls[0]?.url ?? "").searchParams
    expect(params.get("q")).toBe("analytics")
    expect(params.get("dateRange")).toBe(
      "(start:(year:2026,month:8,day:1),end:(year:2026,month:8,day:20))"
    )
    expect(params.get("accounts")).toBe("List(urn:li:sponsoredAccount:123)")
    expect(params.get("fields")).toBe("impressions,costInLocalCurrency,pivotValues")
    expect(params.get("sortBy.field")).toBe("IMPRESSIONS")
    expect(rows[0]?.costInLocalCurrency).toBe("12.50")
  })

  test("supports statistics with up to three pivots", async () => {
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.adAnalytics.statistics({
      pivots: ["CAMPAIGN", "CREATIVE"],
      dateRange: { start: { year: 2026, month: 1, day: 1 } },
      timeGranularity: "ALL",
      fields: ["impressions", "pivotValues"],
      campaigns: [sponsoredCampaignUrn(456)],
    })

    expect(new URL(calls[0]?.url ?? "").searchParams.get("pivots")).toBe("List(CAMPAIGN,CREATIVE)")
  })

  test("serializes the attributed-revenue account as a Rest.li list", async () => {
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.adAnalytics.attributedRevenue({
      pivots: ["ACCOUNT"],
      account: sponsoredAccountUrn(123),
      dateRange: { start: { year: 2026, month: 1, day: 1 } },
      fields: ["revenueAttributionMetrics", "dateRange", "pivotValues"],
    })

    const params = new URL(calls[0]?.url ?? "").searchParams
    expect(params.get("q")).toBe("attributedRevenueMetrics")
    expect(params.get("account")).toBe("List(urn:li:sponsoredAccount:123)")
  })

  test("tunnels long GET queries through a form-encoded POST", async () => {
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient({ queryTunnelingThreshold: 0 })

    await client.adAnalytics.analytics({
      pivot: "CAMPAIGN",
      dateRange: { start: { year: 2026, month: 8, day: 1 } },
      timeGranularity: "ALL",
      fields: ["impressions", "clicks"],
      accounts: [sponsoredAccountUrn(123)],
    })

    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://api.linkedin.com/rest/adAnalytics")
    expect(calls[0]?.headers.get("x-http-method-override")).toBe("GET")
    expect(calls[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(calls[0]?.body).toContain("q=analytics")
    expect(calls[0]?.body).toContain("accounts=List(urn%3Ali%3AsponsoredAccount%3A123)")
  })

  test("rejects invalid report shapes before making a request", async () => {
    const client = await createTestClient()
    expect(() =>
      client.adAnalytics.analytics({
        pivot: "CAMPAIGN",
        dateRange: { start: { year: 2026, month: 2, day: 30 } },
        timeGranularity: "ALL",
        fields: ["impressions"],
        accounts: [sponsoredAccountUrn(123)],
      })
    ).toThrow("invalid UTC date")

    expect(() =>
      client.adAnalytics.statistics({
        pivots: [],
        dateRange: { start: { year: 2026, month: 1, day: 1 } },
        timeGranularity: "ALL",
        fields: ["impressions"],
        accounts: [sponsoredAccountUrn(123)],
      })
    ).toThrow("one to three pivots")
  })
})
