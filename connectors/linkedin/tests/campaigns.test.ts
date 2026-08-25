import { afterEach, describe, expect, test } from "bun:test"
import { sponsoredAccountUrn, sponsoredCampaignGroupUrn, sponsoredCampaignUrn } from "../src"
import { createTestClient, empty, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin campaigns", () => {
  test("scopes campaign-group searches to an ad account", async () => {
    const calls = recorder([json({ elements: [], metadata: {} })])
    const client = await createTestClient()

    await client.adAccount(123).campaignGroups.search({ statuses: ["ACTIVE", "DRAFT"] })

    const url = new URL(calls[0]?.url ?? "")
    expect(url.pathname).toBe("/rest/adAccounts/123/adCampaignGroups")
    expect(url.searchParams.get("search")).toBe("(status:(values:List(ACTIVE,DRAFT)))")
  })

  test("creates a campaign faithfully and returns the response id", async () => {
    const calls = recorder([empty(201, { "x-restli-id": "987" })])
    const client = await createTestClient()
    const account = sponsoredAccountUrn(123)

    const result = await client.adAccount(123).campaigns.create({
      account,
      campaignGroup: sponsoredCampaignGroupUrn(456),
      name: "Awareness",
      costType: "CPM",
      locale: { country: "US", language: "en" },
      offsiteDeliveryEnabled: false,
      targetingCriteria: {
        include: {
          and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"] } }],
        },
      },
      type: "SPONSORED_UPDATES",
      unitCost: { amount: "15", currencyCode: "USD" },
      dailyBudget: { amount: "50", currencyCode: "USD" },
      status: "ACTIVE",
      politicalIntent: "NOT_POLITICAL",
    })

    const body = JSON.parse(calls[0]?.body ?? "{}")
    expect(result.id).toBe("987")
    expect(body.campaignGroup).toBe("urn:li:sponsoredCampaignGroup:456")
    expect(body.politicalIntent).toBe("NOT_POLITICAL")
    expect(body.targetingCriteria.include.and[0].or).toEqual({
      "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"],
    })
  })

  test("updates and deletes campaigns with the documented wire methods", async () => {
    const calls = recorder([empty(), empty()])
    const client = await createTestClient()

    await client.adAccount(123).campaigns.update(987, { status: "ARCHIVED" }, ["totalBudget"])
    await client.adAccount(123).campaigns.deleteDraft(987)

    expect(calls[0]?.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE")
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      patch: { $set: { status: "ARCHIVED" }, $delete: ["totalBudget"] },
    })
    expect(calls[1]?.method).toBe("DELETE")
  })

  test("searches campaign URNs with Rest.li structural encoding", async () => {
    const calls = recorder([json({ elements: [], metadata: {} })])
    const client = await createTestClient()

    await client.adAccount(123).campaigns.search({
      ids: [sponsoredCampaignUrn(987)],
      campaignGroups: [sponsoredCampaignGroupUrn(456)],
    })

    const search = new URL(calls[0]?.url ?? "").searchParams.get("search") ?? ""
    expect(search).toContain("id:(values:List(urn:li:sponsoredCampaign:987))")
    expect(search).toContain("campaignGroup:(values:List(urn:li:sponsoredCampaignGroup:456))")
  })

  test("rejects searches without the criteria required by LinkedIn", async () => {
    const client = await createTestClient()
    await expect(client.adAccount(123).campaigns.search({})).rejects.toThrow(
      "requires at least one criterion"
    )
  })
})
