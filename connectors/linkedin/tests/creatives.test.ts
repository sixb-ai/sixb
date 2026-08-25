import { afterEach, describe, expect, test } from "bun:test"
import { sponsoredCampaignUrn, sponsoredCreativeUrn } from "../src"
import { createTestClient, empty, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin creatives", () => {
  test("encodes creative URNs as path segments", async () => {
    const id = sponsoredCreativeUrn(120491345)
    const calls = recorder([
      json({ id, campaign: sponsoredCampaignUrn(1), intendedStatus: "DRAFT" }),
    ])
    const client = await createTestClient()

    await client.adAccount(123).creatives.get(id)

    expect(new URL(calls[0]?.url ?? "").pathname).toEndWith(
      "/creatives/urn%3Ali%3AsponsoredCreative%3A120491345"
    )
  })

  test("uses the criteria finder and creative cursor pagination", async () => {
    const calls = recorder([
      json({
        elements: [],
        metadata: { nextPageToken: "next", totalResultCount: 42 },
      }),
    ])
    const client = await createTestClient()

    const page = await client.adAccount(123).creatives.search({
      campaigns: [sponsoredCampaignUrn(456)],
      intendedStatuses: ["ACTIVE", "PAUSED"],
      isTotalIncluded: true,
      pageSize: 100,
    })

    const url = new URL(calls[0]?.url ?? "")
    expect(calls[0]?.headers.get("x-restli-method")).toBe("FINDER")
    expect(url.searchParams.get("campaigns")).toBe("List(urn:li:sponsoredCampaign:456)")
    expect(url.searchParams.get("intendedStatuses")).toBe("List(ACTIVE,PAUSED)")
    expect(url.searchParams.get("isTotalIncluded")).toBe("true")
    expect(page.nextPageToken).toBe("next")
    expect(page.totalCount).toBe(42)
  })

  test("creates and updates creatives without reshaping content", async () => {
    const id = sponsoredCreativeUrn(789)
    const calls = recorder([empty(201, { "x-restli-id": id }), empty()])
    const client = await createTestClient()

    const created = await client.adAccount(123).creatives.create({
      campaign: sponsoredCampaignUrn(456),
      intendedStatus: "DRAFT",
      content: { reference: "urn:li:ugcPost:42" },
    })
    await client.adAccount(123).creatives.update(id, { intendedStatus: "ACTIVE" })

    expect(created.id).toBe(id)
    expect(JSON.parse(calls[0]?.body ?? "{}").content).toEqual({ reference: "urn:li:ugcPost:42" })
    expect(calls[1]?.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE")
  })

  test("enforces LinkedIn's creative page-size limit", async () => {
    const client = await createTestClient()
    await expect(client.adAccount(123).creatives.search({ pageSize: 101 })).rejects.toThrow(
      "between 1 and 100"
    )
  })
})
