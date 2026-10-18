import { afterEach, expect, test } from "bun:test"
import { type QuickBooksEntity, type QuickBooksInvoiceListOptions, quickbooks } from "../src"
import {
  bill,
  billPayment,
  creditMemo,
  invoice,
  payment,
  vendorCredit,
} from "./fixtures/transactions"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
async function client() {
  return quickbooks({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    retry: { maxRetries: 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "c",
    account: { id: "123", label: "Company" },
    signal: new AbortController().signal,
    tokenSource: {
      async get() {
        return { accessToken: "token", invalidate() {} }
      },
    },
  })
}
function mock(handler: (url: URL) => unknown) {
  globalThis.fetch = ((url) =>
    Promise.resolve(Response.json(handler(new URL(String(url)))))) as typeof fetch
}
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

for (const [resource, entity, path, sample] of [
  ["invoices", "Invoice", "invoice", invoice],
  ["payments", "Payment", "payment", payment],
  ["creditMemos", "CreditMemo", "creditmemo", creditMemo],
  ["bills", "Bill", "bill", bill],
  ["billPayments", "BillPayment", "billpayment", billPayment],
  ["vendorCredits", "VendorCredit", "vendorcredit", vendorCredit],
] as const) {
  test(`${resource}: get and listAll preserve full provider lines, links, amounts and metadata`, async () => {
    const qb = await client()
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/${path}/42`)
      expect(url.searchParams.get("minorversion")).toBe("75")
      return { [entity]: sample }
    })
    expect(await qb[resource].get("42")).toEqual(sample)
    mock((url) => {
      expect(url.pathname).toBe("/v3/company/123/query")
      // Removal proof: append Active = true in listTransactions; this exact query check fails.
      expect(url.searchParams.get("query")).toBe(
        `SELECT * FROM ${entity} ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100`
      )
      return { QueryResponse: { [entity]: [sample], startPosition: 1, maxResults: 1 } }
    })
    expect(await collect<QuickBooksEntity>(qb[resource].listAll())).toEqual([sample])
  })
}

test("transaction iterator preserves ID and date filters, accepts leap dates and advances positions", async () => {
  const qb = await client()
  const positions: number[] = []
  mock((url) => {
    const query = url.searchParams.get("query") ?? ""
    expect(query).toContain(
      "FROM Invoice WHERE Id IN ('42') AND TxnDate >= '2024-02-29' AND TxnDate <= '2026-09-30' ORDERBY TxnDate DESC"
    )
    expect(query).not.toContain("Active")
    const position = Number(query.match(/STARTPOSITION (\d+)/)?.[1])
    positions.push(position)
    return position === 2
      ? { QueryResponse: { Invoice: [invoice], startPosition: 2, maxResults: 1 } }
      : { QueryResponse: {} }
  })
  const results = await collect(
    qb.invoices.listAll({
      ids: ["42"],
      txnDateFrom: "2024-02-29",
      txnDateTo: "2026-09-30",
      startPosition: 2,
      maxResults: 1,
      orderBy: { field: "TxnDate", direction: "DESC" },
    })
  )
  expect(results).toEqual([invoice])
  expect(positions).toEqual([2, 3])
})

test("transaction dates and unsupported filters reject before fetch", async () => {
  // Removal proof: remove calendar round-trip validation in dateLiteral; February 30 is accepted.
  let calls = 0
  mock(() => {
    calls++
    return { QueryResponse: {} }
  })
  const qb = await client()
  for (const options of [
    { txnDateFrom: "2026-02-30" },
    { txnDateTo: "2026-13-01" },
    { txnDateFrom: "2026-09-01T12:00:00Z" },
    { txnDateFrom: "2026-09-30", txnDateTo: "2026-09-01" },
    { maxResults: 1001 },
    { ids: [] },
  ])
    await expect(qb.invoices.list(options)).rejects.toThrow("[SixbQuickBooks]")
  await expect(
    qb.invoices.list({ active: false } as unknown as QuickBooksInvoiceListOptions)
  ).rejects.toThrow("Unsupported transaction list option")
  expect(calls).toBe(0)
})
