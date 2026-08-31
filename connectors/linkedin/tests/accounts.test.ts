import { afterEach, describe, expect, test } from "bun:test"
import { sponsoredAccountUrn } from "../src"
import { collect, createTestClient, empty, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin advertising accounts", () => {
  test("search serializes Rest.li criteria and exposes the next cursor", async () => {
    const calls = recorder([
      json({
        elements: [{ id: 1, name: "Acme", type: "BUSINESS", status: "ACTIVE" }],
        metadata: { nextPageToken: "next-token" },
      }),
    ])
    const client = await createTestClient()

    const page = await client.adAccounts.search({
      statuses: ["ACTIVE", "CANCELED"],
      types: ["BUSINESS"],
      test: false,
      sortOrder: "DESCENDING",
      pageSize: 250,
    })

    const url = new URL(calls[0]?.url ?? "")
    expect(url.pathname).toBe("/rest/adAccounts")
    expect(url.searchParams.get("q")).toBe("search")
    expect(url.searchParams.get("search")).toBe(
      "(status:(values:List(ACTIVE,CANCELED)),type:(values:List(BUSINESS)),test:false)"
    )
    expect(url.searchParams.get("pageSize")).toBe("250")
    expect(page.nextPageToken).toBe("next-token")
    expect(page.items[0]?.name).toBe("Acme")
  })

  test("searchAll follows cursor metadata without changing the search", async () => {
    const calls = recorder((call) => {
      const token = new URL(call.url).searchParams.get("pageToken")
      return token
        ? json({ elements: [{ id: 2, name: "B", type: "BUSINESS" }], metadata: {} })
        : json({
            elements: [{ id: 1, name: "A", type: "BUSINESS" }],
            metadata: { nextPageToken: "page-2" },
          })
    })
    const client = await createTestClient()

    const accounts = await collect(client.adAccounts.searchAll({ statuses: ["ACTIVE"] }))

    expect(accounts.map((account) => account.id)).toEqual([1, 2])
    expect(new URL(calls[1]?.url ?? "").searchParams.get("pageToken")).toBe("page-2")
    expect(new URL(calls[1]?.url ?? "").searchParams.get("search")).toContain("ACTIVE")
  })

  test("create reads x-restli-id and update uses a partial update", async () => {
    const calls = recorder([empty(201, { "x-restli-id": "123" }), empty()])
    const client = await createTestClient()

    const created = await client.adAccounts.create({ name: "Acme", type: "BUSINESS" })
    await client.adAccounts.update(123, { name: "Renamed" })

    expect(created.id).toBe("123")
    expect(calls[0]?.method).toBe("POST")
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "Acme", type: "BUSINESS" })
    expect(calls[1]?.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE")
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      patch: { $set: { name: "Renamed" } },
    })
  })

  test("account users use the compound key and authenticated-user finder", async () => {
    const account = sponsoredAccountUrn(123)
    const user = "urn:li:person:abc" as const
    const calls = recorder([
      json({ account, user, role: "ACCOUNT_MANAGER" }),
      json({
        elements: [{ account, user, role: "ACCOUNT_MANAGER" }],
        paging: { start: 0, count: 1, total: 1, links: [] },
      }),
      empty(),
    ])
    const client = await createTestClient()

    await client.adAccountUsers.get(account, user)
    const page = await client.adAccountUsers.listByAuthenticatedUser({ count: 10 })
    await client.adAccountUsers.revoke(account, user)

    expect(decodeURIComponent(new URL(calls[0]?.url ?? "").pathname)).toContain(
      "(account=urn:li:sponsoredAccount:123,user=urn:li:person:abc)"
    )
    expect(new URL(calls[1]?.url ?? "").searchParams.get("q")).toBe("authenticatedUser")
    expect(page.paging.total).toBe(1)
    expect(calls[2]?.method).toBe("DELETE")
  })
})
