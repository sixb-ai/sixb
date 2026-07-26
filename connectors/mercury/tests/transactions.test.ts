import { afterEach, expect, test } from "bun:test"
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

test("list surfaces both category concepts on a transaction", async () => {
  recorder([
    json({
      transactions: [
        transaction("t1", {
          mercuryCategory: "Software",
          categoryData: {
            id: "cat-1",
            name: "Engineering Tools",
            visibleForReimbursements: false,
            visibleForCardSpend: true,
            visibleForOther: true,
          },
          merchant: { id: "m-1", category: "Software", categoryCode: "5734", currency: "USD" },
        }),
      ],
      page: {},
    }),
  ])
  const mc = await createTestClient()

  const page = await mc.transactions.list()
  const [txn] = page.transactions

  expect(txn?.mercuryCategory).toBe("Software")
  expect(txn?.categoryData?.name).toBe("Engineering Tools")
  expect(txn?.merchant?.categoryCode).toBe("5734")
})

test("start_at cannot be combined with the directional cursors", async () => {
  const mc = await createTestClient()

  expect(() => mc.transactions.list({ start_at: "t1", start_after: "t2" })).toThrow(
    "start_at cannot be combined"
  )
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

test("update PATCHes only the fields the caller supplied", async () => {
  const calls = recorder([json(transaction("t1", { note: "Team lunch" }))])
  const mc = await createTestClient()

  await mc.transactions.update("t1", { note: "Team lunch" })

  expect(calls[0]?.method).toBe("PATCH")
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ note: "Team lunch" })
})

test("update sends an explicit null to clear a field", async () => {
  const calls = recorder([json(transaction("t1"))])
  const mc = await createTestClient()

  await mc.transactions.update("t1", { categoryId: null })

  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ categoryId: null })
})

test("update rejects an empty payload rather than sending a no-op write", async () => {
  const mc = await createTestClient()

  expect(() => mc.transactions.update("t1", {})).toThrow("at least one of note or categoryId")
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

test("account transaction offset must be non-negative", async () => {
  const mc = await createTestClient()

  expect(() => mc.transactions.listForAccount("acct-1", { offset: -1 })).toThrow(
    "non-negative integer"
  )
})

test("empty path ids are rejected before a request is made", async () => {
  const mc = await createTestClient()

  expect(() => mc.transactions.get("  ")).toThrow("transaction id must be a non-empty string")
})
