import { afterEach, describe, expect, test } from "bun:test"
import { linkedin } from "../src"
import { CONTEXT, DEFAULT_OPTIONS, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const CREDENTIALS = { accessToken: "discovery-token", tokenType: "Bearer" }

describe("linkedin managed account discovery", () => {
  test("discovers and deduplicates approved administered Pages", async () => {
    const calls = recorder([
      json({
        elements: [
          {
            role: "ADMINISTRATOR",
            state: "APPROVED",
            roleAssignee: "urn:li:person:9",
            organizationTarget: "urn:li:organization:42",
          },
          {
            role: "ANALYST",
            state: "APPROVED",
            roleAssignee: "urn:li:person:9",
            organizationTarget: "urn:li:organization:42",
          },
        ],
        paging: { start: 0, count: 2, total: 2 },
      }),
      json({ id: 42, localizedName: "Sixb", vanityName: "sixb-ai" }),
    ])
    const connector = linkedin({
      ...DEFAULT_OPTIONS,
      scopes: ["rw_organization_admin"],
      accountType: "organization",
    })

    const accounts = await connector.discoverAccounts(CONTEXT, CREDENTIALS)

    expect(accounts).toEqual([
      {
        id: "urn:li:organization:42",
        label: "Sixb",
        description: "LinkedIn Page · linkedin.com/company/sixb-ai",
      },
    ])
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=0&count=100",
      "https://api.linkedin.com/rest/organizations/42",
    ])
    expect(
      calls.every((call) => call.headers.get("authorization") === "Bearer discovery-token")
    ).toBe(true)
  })

  test("discovers accessible advertising accounts", async () => {
    recorder([
      json({
        elements: [
          {
            account: "urn:li:sponsoredAccount:123",
            user: "urn:li:person:9",
            role: "ACCOUNT_MANAGER",
          },
        ],
        paging: { start: 0, count: 1, total: 1 },
      }),
      json({
        id: 123,
        name: "Sixb Ads",
        type: "BUSINESS",
        status: "ACTIVE",
        currency: "EUR",
      }),
    ])

    const accounts = await linkedin(DEFAULT_OPTIONS).discoverAccounts(CONTEXT, CREDENTIALS)

    expect(accounts).toEqual([
      {
        id: "urn:li:sponsoredAccount:123",
        label: "Sixb Ads",
        description: "LinkedIn ad account · ACTIVE · EUR",
      },
    ])
  })
})
