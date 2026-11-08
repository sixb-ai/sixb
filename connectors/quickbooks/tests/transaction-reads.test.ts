import { afterEach, expect, test } from "bun:test"
import {
  type QuickBooksRecurringTransactionListOptions,
  type QuickBooksReimburseChargeListOptions,
  type QuickBooksTaxPaymentListOptions,
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
function mock(handler: (url: URL) => unknown) {
  globalThis.fetch = ((input) =>
    Promise.resolve(Response.json(handler(new URL(String(input)))))) as typeof fetch
}
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}
const since = new Date("2026-09-01T00:00:00.000Z")

// Synthetic partial samples; predicates match what the live sandbox accepted per entity.
for (const [resource, entity, path, sample, options, query] of [
  [
    "reimburseCharges",
    "ReimburseCharge",
    "reimbursecharge",
    {
      Id: "42",
      CustomerRef: { value: "9" },
      HasBeenInvoiced: false,
      Amount: 12.5,
      Line: [
        {
          Id: "1",
          Amount: 12.5,
          DetailType: "ReimburseLineDetail",
          ReimburseLineDetail: { ItemAccountRef: { value: "8" } },
        },
      ],
    },
    { customerIds: ["9"], updatedSince: since },
    "SELECT * FROM ReimburseCharge WHERE CustomerRef IN ('9') AND MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ],
  [
    "creditCardPayments",
    "CreditCardPayment",
    "creditcardpayment",
    {
      Id: "42",
      TxnDate: "2026-09-02",
      Amount: 300,
      BankAccountRef: { value: "35" },
      CreditCardAccountRef: { value: "41" },
    },
    { txnDateFrom: "2026-09-01", docNumber: "1001" },
    "SELECT * FROM CreditCardPayment WHERE TxnDate >= '2026-09-01' AND DocNumber = '1001' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ],
  [
    "inventoryAdjustments",
    "InventoryAdjustment",
    "inventoryadjustment",
    {
      Id: "42",
      DocNumber: "START",
      AdjustAccountRef: { value: "92" },
      Line: [
        {
          Id: "1",
          DetailType: "ItemAdjustmentLineDetail",
          ItemAdjustmentLineDetail: { ItemRef: { value: "3" }, QtyDiff: -2.5 },
        },
      ],
    },
    { docNumber: "START", orderBy: { field: "TxnDate" as const, direction: "DESC" as const } },
    "SELECT * FROM InventoryAdjustment WHERE DocNumber = 'START' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100",
  ],
  [
    "taxPayments",
    "TaxPayment",
    "taxpayment",
    { Id: "42", PaymentDate: "2026-09-30", PaymentAmount: 410.25, Refund: false },
    { ids: ["42"] },
    "SELECT * FROM TaxPayment WHERE Id IN ('42') ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ],
] as const) {
  test(`${resource}: get and list use the ${entity} envelope and supported predicates`, async () => {
    const target = (await client())[resource] as unknown as {
      get(id: string): Promise<unknown>
      list(options: object): Promise<{ items: readonly unknown[] }>
    }
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/${path}/42`)
      return { [entity]: sample }
    })
    expect(await target.get("42")).toEqual(sample)
    mock((url) => {
      expect(url.searchParams.get("query")).toBe(query)
      return { QueryResponse: { [entity]: [sample] } }
    })
    expect((await target.list(options)).items).toEqual([sample])
  })
}

test("entities without TxnDate or DocNumber predicates reject them locally", async () => {
  let calls = 0
  mock(() => {
    calls++
    return { QueryResponse: {} }
  })
  const qb = await client()
  for (const option of ["txnDateFrom", "docNumber", "vendorIds"])
    await expect(
      qb.reimburseCharges.list({
        [option]: "2026-09-01",
      } as unknown as QuickBooksReimburseChargeListOptions)
    ).rejects.toThrow(`Unsupported transaction list option: ${option}`)
  await expect(
    qb.taxPayments.list({
      orderBy: { field: "TxnDate" },
    } as unknown as QuickBooksTaxPaymentListOptions)
  ).rejects.toThrow("Unsupported transaction sort")
  expect(calls).toBe(0)
})

test("recurring transactions keep the template wrapper and filter by template type", async () => {
  const template = {
    Bill: {
      Id: "23",
      SyncToken: "0",
      VendorRef: { value: "40" },
      TotalAmt: 900,
      RecurDataRef: { value: "3" },
      RecurringInfo: {
        Name: "Monthly lease",
        RecurType: "Automated",
        Active: true,
        ScheduleInfo: { IntervalType: "Monthly", NumInterval: 1, DayOfMonth: 1 },
      },
    },
  }
  const qb = await client()
  mock((url) => {
    expect(url.pathname).toBe("/v3/company/123/recurringtransaction/23")
    return { RecurringTransaction: template }
  })
  expect(await qb.recurringTransactions.get("23")).toEqual(template)
  const queries: string[] = []
  mock((url) => {
    const query = url.searchParams.get("query") ?? ""
    queries.push(query)
    return {
      QueryResponse: query.includes("STARTPOSITION 1 ")
        ? { RecurringTransaction: [template], startPosition: 1, maxResults: 1 }
        : {},
    }
  })
  expect(
    await collect(
      qb.recurringTransactions.listAll({ type: "Bill", updatedSince: since, maxResults: 1 })
    )
  ).toEqual([template])
  expect(queries).toEqual([
    "SELECT * FROM RecurringTransaction WHERE MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' AND Type = 'Bill' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 1",
    "SELECT * FROM RecurringTransaction WHERE MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' AND Type = 'Bill' ORDERBY Id ASC STARTPOSITION 2 MAXRESULTS 1",
  ])
})

test("malformed recurring wrappers and options are rejected", async () => {
  const qb = await client()
  // Removal proof: return the wrapper without recurringTemplate(); these resolve instead.
  for (const body of [
    { RecurringTransaction: { Bill: { Id: "24" } } },
    { RecurringTransaction: { Bill: { Id: "23" }, Invoice: { Id: "23" } } },
    { RecurringTransaction: { Bill: {} } },
    { RecurringTransaction: { Id: "23" } },
  ]) {
    mock(() => body)
    await expect(qb.recurringTransactions.get("23")).rejects.toThrow("RecurringTransaction")
  }
  mock(() => ({ QueryResponse: { RecurringTransaction: [{ Id: "23" }] } }))
  await expect(qb.recurringTransactions.list()).rejects.toThrow("Invalid RecurringTransaction")
  let calls = 0
  mock(() => {
    calls++
    return { QueryResponse: {} }
  })
  for (const options of [
    { type: "Bill' OR Id > '0" },
    { txnDateFrom: "2026-09-01" },
    { docNumber: "1" },
  ])
    await expect(
      qb.recurringTransactions.list(options as unknown as QuickBooksRecurringTransactionListOptions)
    ).rejects.toThrow("[SixbQuickBooks]")
  expect(calls).toBe(0)
})
