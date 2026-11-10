import { afterEach, expect, test } from "bun:test"
import {
  type QuickBooksBillListOptions,
  type QuickBooksCustomerListOptions,
  type QuickBooksInvoiceListOptions,
  type QuickBooksPaymentListOptions,
  type QuickBooksTransferListOptions,
  quickbooks,
} from "../src"

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
function capture(entity: string) {
  const queries: string[] = []
  globalThis.fetch = ((input) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe("/v3/company/123/query")
    queries.push(url.searchParams.get("query") ?? "")
    return Promise.resolve(Response.json({ QueryResponse: { [entity]: [] } }))
  }) as typeof fetch
  return queries
}
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
const since = new Date("2026-09-01T12:30:00.000Z")

// Provider support for each predicate was checked against the sandbox (see tests/README.md):
// unsupported properties return 4001 "Property X not found", so they are rejected locally instead.
for (const [resource, entity, party, partyField] of [
  ["invoices", "Invoice", "customerIds", "CustomerRef"],
  ["creditMemos", "CreditMemo", "customerIds", "CustomerRef"],
  ["bills", "Bill", "vendorIds", "VendorRef"],
  ["billPayments", "BillPayment", "vendorIds", "VendorRef"],
  ["vendorCredits", "VendorCredit", "vendorIds", "VendorRef"],
] as const) {
  test(`${resource}: party, document number and modification filters serialize in a fixed order`, async () => {
    const queries = capture(entity)
    const qb = await client()
    await qb[resource].list({
      ids: ["1"],
      txnDateFrom: "2026-09-01",
      docNumber: "INV-'7",
      [party]: ["9", "1'0"],
      updatedSince: since,
      orderBy: { field: "TxnDate", direction: "DESC" },
    })
    expect(queries).toEqual([
      `SELECT * FROM ${entity} WHERE Id IN ('1') AND TxnDate >= '2026-09-01' AND DocNumber = 'INV-\\'7' AND ${partyField} IN ('9', '1\\'0') AND MetaData.LastUpdatedTime >= '2026-09-01T12:30:00.000Z' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100`,
    ])
  })
}

test("customer-linked transactions reject vendor filters and vice versa before fetch", async () => {
  // Removal proof: drop the party option from allowedOptions in listTransactions; the
  // invoice vendor filter then reaches the provider, which rejects VendorRef with 4001.
  const queries = capture("Invoice")
  const qb = await client()
  await expect(
    qb.invoices.list({ vendorIds: ["1"] } as unknown as QuickBooksInvoiceListOptions)
  ).rejects.toThrow("Unsupported transaction list option: vendorIds")
  await expect(
    qb.bills.list({ customerIds: ["1"] } as unknown as QuickBooksBillListOptions)
  ).rejects.toThrow("Unsupported transaction list option: customerIds")
  for (const options of [
    { customerIds: [] },
    { customerIds: [""] },
    { docNumber: "" },
    { updatedSince: new Date(Number.NaN) },
    { updatedSince: "2026-09-01" as unknown as Date },
    { orderBy: { field: "DocNumber" } } as unknown as QuickBooksInvoiceListOptions,
  ])
    await expect(qb.invoices.list(options)).rejects.toThrow("[SixbQuickBooks]")
  expect(queries).toEqual([])
})

test("name lists add a modification bound and reject unknown options and timestamp sorts", async () => {
  const queries = capture("Customer")
  const qb = await client()
  await qb.customers.list({ active: "all", updatedSince: since })
  expect(queries).toEqual([
    "SELECT * FROM Customer WHERE Active IN (true, false) AND MetaData.LastUpdatedTime >= '2026-09-01T12:30:00.000Z' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ])
  // Offset pages over a timestamp sort skip rows that move when updated mid-sync.
  await expect(
    qb.customers.list({
      orderBy: { field: "MetaData.LastUpdatedTime" },
    } as unknown as QuickBooksCustomerListOptions)
  ).rejects.toThrow("Unsupported query sort")
  // Removal proof: remove allowedOptions from listEntities; the typo is silently ignored.
  await expect(
    qb.customers.list({ activ: false } as unknown as QuickBooksCustomerListOptions)
  ).rejects.toThrow("Unsupported list option: activ")
  await expect(qb.customers.list({ updatedSince: new Date(Number.NaN) })).rejects.toThrow(
    "updatedSince"
  )
  expect(queries).toHaveLength(1)
})

test("listAll carries every new filter to each page", async () => {
  const queries: string[] = []
  globalThis.fetch = ((input) => {
    const query = new URL(String(input)).searchParams.get("query") ?? ""
    queries.push(query)
    const start = Number(query.match(/STARTPOSITION (\d+)/)?.[1])
    return Promise.resolve(
      Response.json({
        QueryResponse: start === 1 ? { Bill: [{ Id: "1" }], startPosition: 1, maxResults: 1 } : {},
      })
    )
  }) as typeof fetch
  const qb = await client()
  const rows = await collect(
    qb.bills.listAll({ vendorIds: ["7"], docNumber: "B-1", updatedSince: since, maxResults: 1 })
  )
  expect(rows).toEqual([{ Id: "1" }])
  expect(queries).toHaveLength(2)
  for (const query of queries)
    expect(query).toContain(
      "DocNumber = 'B-1' AND VendorRef IN ('7') AND MetaData.LastUpdatedTime >= '2026-09-01T12:30:00.000Z'"
    )
})

test("payments filter by PaymentRefNum; payments and transfers have no DocNumber filter", async () => {
  // Live sandbox: creating a payment or transfer with DocNumber did not store it, while a
  // PaymentRefNum filter returned the payment. Removal proof: drop docNumber: false from
  // payments.list; the docNumber case below then reaches fetch.
  const queries = capture("Payment")
  const qb = await client()
  await qb.payments.list({ paymentRefNum: "CHK-1'2", customerIds: ["9"] })
  expect(queries).toEqual([
    "SELECT * FROM Payment WHERE CustomerRef IN ('9') AND PaymentRefNum = 'CHK-1\\'2' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ])
  await expect(
    qb.payments.list({ docNumber: "1" } as unknown as QuickBooksPaymentListOptions)
  ).rejects.toThrow("Unsupported transaction list option: docNumber")
  await expect(
    qb.transfers.list({ docNumber: "1" } as unknown as QuickBooksTransferListOptions)
  ).rejects.toThrow("Unsupported transaction list option: docNumber")
  await expect(qb.payments.list({ paymentRefNum: "" })).rejects.toThrow("query value")
  expect(queries).toHaveLength(1)
})
