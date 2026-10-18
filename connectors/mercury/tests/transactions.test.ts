import { afterEach, expect, test } from "bun:test"
import type { MercuryClient } from "../src"
import { collect, createTestClient, json, query, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    accountId: "acct-1",
    amount: -42.5,
    status: "sent",
    kind: "debitCardTransaction",
    counterpartyId: "cp-1",
    counterpartyName: "Acme Coffee",
    createdAt: "2026-07-01T12:00:00Z",
    estimatedDeliveryDate: "2026-07-02T00:00:00Z",
    compliantWithReceiptPolicy: true,
    hasGeneratedReceipt: false,
    glAllocations: [],
    attachments: [],
    relatedTransactions: [],
    dashboardLink: `https://app.mercury.com/transactions/${id}`,
    ...overrides,
  }
}

test("list repeats array filters as separate query parameters", async () => {
  const calls = recorder([json({ transactions: [transaction("t1")], page: {} })])
  const mc = await createTestClient()

  await mc.transactions.list({
    status: ["pending", "sent"],
    accountId: ["acct-1", "acct-2"],
    postedStart: "2026-07-01",
    mercuryCategory: "Restaurants",
  })

  const params = query(calls[0]?.url ?? "")
  expect(params.getAll("status")).toEqual(["pending", "sent"])
  expect(params.getAll("accountId")).toEqual(["acct-1", "acct-2"])
  expect(params.get("postedStart")).toBe("2026-07-01")
  expect(params.get("mercuryCategory")).toBe("Restaurants")
})

test("listAll drops start_at once it begins following nextPage", async () => {
  const calls = recorder([
    json({ transactions: [transaction("t1")], page: { nextPage: "t1" } }),
    json({ transactions: [transaction("t2")], page: {} }),
  ])
  const mc = await createTestClient()

  const transactions = await collect(mc.transactions.listAll({ start_at: "t1" }))

  expect(transactions.map((entry) => entry.id)).toEqual(["t1", "t2"])
  expect(query(calls[0]?.url ?? "").get("start_at")).toBe("t1")
  expect(query(calls[1]?.url ?? "").has("start_at")).toBe(false)
  expect(query(calls[1]?.url ?? "").get("start_after")).toBe("t1")
})

test("get reads the singular transaction path", async () => {
  const calls = recorder([json(transaction("t1"))])
  const mc = await createTestClient()

  const txn = await mc.transactions.get("t1")

  expect(txn.id).toBe("t1")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/transaction/t1")
})

test.each([
  // An omitted field means "leave unchanged", so only the supplied one is sent.
  ["only the fields the caller supplied", { note: "Team lunch" }],
  ["an explicit null to clear a field", { categoryId: null }],
])("update PATCHes %s", async (_name, input) => {
  const calls = recorder([json(transaction("t1"))])
  const mc = await createTestClient()

  await mc.transactions.update("t1", input)

  expect(calls[0]?.method).toBe("PATCH")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/transaction/t1")
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(input)
})

test("listAllForAccount pages by offset until it reaches total", async () => {
  const calls = recorder([
    json({ transactions: [transaction("t1"), transaction("t2")], total: 3 }),
    json({ transactions: [transaction("t3")], total: 3 }),
  ])
  const mc = await createTestClient()

  const transactions = await collect(mc.transactions.listAllForAccount("acct-1", { limit: 2 }))

  expect(transactions.map((entry) => entry.id)).toEqual(["t1", "t2", "t3"])
  expect(calls[0]?.url).toStartWith("https://api.mercury.com/api/v1/account/acct-1/transactions?")
  expect(query(calls[0]?.url ?? "").get("offset")).toBe("0")
  expect(query(calls[1]?.url ?? "").get("offset")).toBe("2")
})

test("listAllForAccount stops on an empty page even when total disagrees", async () => {
  recorder([
    json({ transactions: [transaction("t1")], total: 99 }),
    json({ transactions: [], total: 99 }),
  ])
  const mc = await createTestClient()

  const transactions = await collect(mc.transactions.listAllForAccount("acct-1"))

  expect(transactions).toHaveLength(1)
})

test("getForAccount encodes both path segments", async () => {
  const calls = recorder([json(transaction("t1"))])
  const mc = await createTestClient()

  await mc.transactions.getForAccount("acct/1", "t 1")

  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/account/acct%2F1/transaction/t%201")
})

test.each([
  [
    "start_at with a directional cursor",
    (mc: MercuryClient) => mc.transactions.list({ start_at: "t1", start_after: "t2" }),
    "start_at cannot be combined",
  ],
  [
    "a negative account transaction offset",
    (mc: MercuryClient) => mc.transactions.listForAccount("acct-1", { offset: -1 }),
    "non-negative integer",
  ],
  [
    "an empty update payload, rather than sending a no-op write",
    (mc: MercuryClient) => mc.transactions.update("t1", {}),
    "at least one of note or categoryId",
  ],
  [
    "an empty path id",
    (mc: MercuryClient) => mc.transactions.get("  "),
    "transaction id must be a non-empty string",
  ],
])("rejects %s before a request is made", async (_name, call, message) => {
  const mc = await createTestClient()

  expect(() => call(mc)).toThrow(message)
})
