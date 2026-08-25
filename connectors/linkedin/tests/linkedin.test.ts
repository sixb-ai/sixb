import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_LINKEDIN_VERSION,
  linkedin,
  organizationUrn,
  shareUrn,
  sponsoredAccountUrn,
  sponsoredCampaignGroupUrn,
  sponsoredCampaignUrn,
  sponsoredCreativeUrn,
  ugcPostUrn,
} from "../src"
import { CONTEXT, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin connector", () => {
  test("sends the required versioned Rest.li headers and resolves live tokens", async () => {
    let tokenNumber = 0
    const calls = recorder([json({ id: 1, name: "Acme", type: "BUSINESS" })])
    const client = await createTestClient({ accessToken: () => `token-${++tokenNumber}` })

    await client.adAccounts.get(1)

    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token-1")
    expect(calls[0]?.headers.get("linkedin-version")).toBe(DEFAULT_LINKEDIN_VERSION)
    expect(calls[0]?.headers.get("x-restli-protocol-version")).toBe("2.0.0")
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
  })

  test("accepts an explicit API version and normalizes a base URL override", async () => {
    const calls = recorder([json({ id: 9, name: "Acme", type: "BUSINESS" })])
    const client = await createTestClient({
      version: "202607",
      baseUrl: "https://example.test/rest",
    })

    await client.adAccounts.get(9)

    expect(calls[0]?.url).toBe("https://example.test/rest/adAccounts/9")
    expect(calls[0]?.headers.get("linkedin-version")).toBe("202607")
  })

  test("validates configuration and resource identifiers early", async () => {
    expect(() => linkedin({ accessToken: " " })).toThrow("accessToken must not be empty")
    expect(() => linkedin({ accessToken: "token", version: "v2" })).toThrow("YYYYMM")
    expect(() => linkedin({ accessToken: "token", baseUrl: " " })).toThrow(
      "baseUrl must not be empty"
    )

    const client = await createTestClient()
    expect(() => client.adAccount("not-a-number")).toThrow("positive numeric ID")
  })

  test("builds typed advertising and community URNs", () => {
    expect(organizationUrn(12)).toBe("urn:li:organization:12")
    expect(shareUrn(34)).toBe("urn:li:share:34")
    expect(ugcPostUrn(56)).toBe("urn:li:ugcPost:56")
    expect(sponsoredAccountUrn(123)).toBe("urn:li:sponsoredAccount:123")
    expect(sponsoredCampaignGroupUrn("456")).toBe("urn:li:sponsoredCampaignGroup:456")
    expect(sponsoredCampaignUrn(789)).toBe("urn:li:sponsoredCampaign:789")
    expect(sponsoredCreativeUrn(321)).toBe("urn:li:sponsoredCreative:321")
  })

  test("rejects an empty token returned by a live resolver", async () => {
    let resolutions = 0
    const client = await linkedin({
      accessToken: () => {
        resolutions++
        return " "
      },
      retry: { maxRetries: 2, delayMs: () => 0 },
    }).connect(CONTEXT)
    await expect(client.adAccounts.get(1)).rejects.toThrow("accessToken must not be empty")
    expect(resolutions).toBe(1)
  })
})
