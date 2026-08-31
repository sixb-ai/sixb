import { afterEach, describe, expect, test } from "bun:test"
import { organizationUrn } from "../src"
import { collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin community organizations", () => {
  test("discovers administered organizations through organization ACLs", async () => {
    const organization = organizationUrn(123)
    const calls = recorder([
      json({
        elements: [
          {
            role: "ADMINISTRATOR",
            state: "APPROVED",
            roleAssignee: "urn:li:person:member",
            organizationTarget: organization,
          },
        ],
        paging: { start: 0, count: 10, total: 1, links: [] },
      }),
      json({
        elements: [],
        paging: { start: 0, count: 10, total: 0, links: [] },
      }),
    ])
    const client = await createTestClient()

    const memberPage = await client.organizationAcls.listForAuthenticatedMember({
      role: "ADMINISTRATOR",
      state: "APPROVED",
      count: 10,
    })
    await client.organizationAcls.listByOrganization(organization, {
      state: "APPROVED",
    })

    const memberUrl = new URL(calls[0]?.url ?? "")
    expect(memberUrl.searchParams.get("q")).toBe("roleAssignee")
    expect(memberUrl.searchParams.get("role")).toBe("ADMINISTRATOR")
    expect(memberPage.items[0]?.organizationTarget).toBe(organization)

    const organizationUrl = new URL(calls[1]?.url ?? "")
    expect(organizationUrl.searchParams.get("q")).toBe("organization")
    expect(organizationUrl.searchParams.get("organization")).toBe(organization)
  })

  test("looks up organization details, children, and the current follower count", async () => {
    const parent = organizationUrn(123)
    const calls = recorder([
      json({ id: 123, localizedName: "Acme" }),
      json({ elements: [{ id: 123, localizedName: "Acme", vanityName: "acme" }] }),
      json({
        elements: [{ id: 456, localizedName: "Acme France" }],
        paging: { start: 0, count: 1, total: 1, links: [] },
      }),
      json({ firstDegreeSize: 42_000 }),
    ])
    const client = await createTestClient()

    const organization = await client.organizations.get(123)
    const vanity = await client.organizations.findByVanityName("acme")
    const children = await collect(client.organizations.listAllByParent(parent, { count: 1 }))
    const followers = await client.organizations.followerCount(parent)

    expect(organization.localizedName).toBe("Acme")
    expect(vanity?.vanityName).toBe("acme")
    expect(children[0]?.id).toBe(456)
    expect(followers).toBe(42_000)
    expect(new URL(calls[1]?.url ?? "").searchParams.get("q")).toBe("vanityName")
    expect(new URL(calls[2]?.url ?? "").searchParams.get("parent")).toBe(parent)
    expect(decodeURIComponent(new URL(calls[3]?.url ?? "").pathname)).toContain(
      `/networkSizes/${parent}`
    )
  })
})
