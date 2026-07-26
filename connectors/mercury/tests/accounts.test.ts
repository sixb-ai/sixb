import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, json, mockFetch, query, recorder, TOKEN } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function account(id: string) {
  return {
    id,
    accountNumber: "9876543210",
    routingNumber: "021000021",
    name: "Mercury Checking",
    status: "active",
    type: "mercury",
    kind: "checking",
    legalBusinessName: "Acme Inc",
    createdAt: "2026-01-02T00:00:00Z",
    availableBalance: 12_500.75,
    currentBalance: 13_000.5,
    dashboardLink: `https://app.mercury.com/accounts/${id}`,
  }
}

test("list sends bearer auth and cursor params against the accounts endpoint", async () => {
  const calls = recorder([json({ accounts: [account("a1")], page: {} })])
  const mc = await createTestClient()

  const page = await mc.accounts.list({ limit: 250, order: "desc" })

  expect(page.accounts[0]?.id).toBe("a1")
  expect(page.accounts[0]?.availableBalance).toBe(12_500.75)
  expect(calls[0]?.url).toStartWith("https://api.mercury.com/api/v1/accounts?")
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("250")
  expect(query(calls[0]?.url ?? "").get("order")).toBe("desc")
})

test("bearer token is sent exactly as provided, including its secret-token prefix", async () => {
  const authorizations: (string | null)[] = []
  mockFetch(async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization"))
    return json({ accounts: [], page: {} })
  })

  const mc = await createTestClient()
  await mc.accounts.list()

  expect(authorizations).toEqual([`Bearer ${TOKEN}`])
})

test("listAll follows page.nextPage as start_after and stops when it is absent", async () => {
  const calls = recorder([
    json({ accounts: [account("a1"), account("a2")], page: { nextPage: "a2" } }),
    json({ accounts: [account("a3")], page: {} }),
  ])
  const mc = await createTestClient()

  const accounts = await collect(mc.accounts.listAll({ limit: 2 }))

  expect(accounts.map((entry) => entry.id)).toEqual(["a1", "a2", "a3"])
  expect(calls).toHaveLength(2)
  expect(query(calls[0]?.url ?? "").has("start_after")).toBe(false)
  expect(query(calls[1]?.url ?? "").get("start_after")).toBe("a2")
  expect(query(calls[1]?.url ?? "").get("limit")).toBe("2")
})

test("listAll throws when the API repeats a cursor instead of looping forever", async () => {
  recorder([
    json({ accounts: [account("a1")], page: { nextPage: "a1" } }),
    json({ accounts: [account("a2")], page: { nextPage: "a1" } }),
  ])
  const mc = await createTestClient()

  await expect(collect(mc.accounts.listAll())).rejects.toThrow(/repeated nextPage cursor/)
})

test("start_after and end_before are rejected together", async () => {
  const mc = await createTestClient()

  expect(() => mc.accounts.list({ start_after: "a1", end_before: "a9" })).toThrow(
    "mutually exclusive"
  )
})

test("limit is validated against Mercury's 1000 ceiling", async () => {
  const mc = await createTestClient()

  expect(() => mc.accounts.list({ limit: 1001 })).toThrow("between 1 and 1000")
  expect(() => mc.accounts.list({ limit: 0 })).toThrow("between 1 and 1000")
})
