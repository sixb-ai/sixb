import { afterEach, expect, test } from "bun:test"
import { type QuickBooksCustomerListOptions, quickbooks } from "../src"
import customerPage from "./fixtures/customer-query.json"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function client() {
  return quickbooks({
    clientId: "client",
    clientSecret: "secret",
    environment: "sandbox",
    retry: { maxRetries: 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "c",
    signal: new AbortController().signal,
    account: { id: "123", label: "company" },
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

// Synthetic wire samples based on Intuit's entity references (linked in the package README).
// They are deliberately partial and are not captures from a live sandbox.
const samples = {
  customers: {
    Id: "42",
    DisplayName: "Branch",
    CompanyName: "Example LLC",
    Job: true,
    ParentRef: { value: "9", name: "Parent" },
    BillWithParent: true,
    Balance: 125.5,
    BalanceWithJobs: 150,
    CurrencyRef: { value: "EUR" },
    BillAddr: { Line1: "1 Example St", City: "Paris" },
    ShipAddr: { Line1: "2 Example St" },
    PrimaryEmailAddr: { Address: "billing@example.test" },
    Notes: "Net terms",
    CustomField: [{ DefinitionId: "1", StringValue: "customer-code", Type: "StringType" }],
  },
  vendors: {
    Id: "42",
    DisplayName: "Supplier",
    Active: false,
    Vendor1099: true,
    TaxIdentifier: "test-id",
    TermRef: { value: "3" },
    APAccountRef: { value: "8" },
    PrimaryPhone: { FreeFormNumber: "555-0100" },
    Balance: -42.75,
    CurrencyRef: { value: "USD" },
  },
  accounts: {
    Id: "42",
    Name: "Checking",
    AccountType: "Bank",
    AccountSubType: "Checking",
    Classification: "Asset",
    CurrentBalance: 1200.25,
    SubAccount: true,
    ParentRef: { value: "1" },
    CurrencyRef: { value: "USD" },
  },
  items: {
    Id: "42",
    Name: "Widget",
    Type: "Inventory",
    Sku: "W-1",
    QtyOnHand: 3.5,
    TrackQtyOnHand: true,
    UnitPrice: 19.95,
    PurchaseCost: 10,
    AssetAccountRef: { value: "7" },
    ExpenseAccountRef: { value: "8" },
    IncomeAccountRef: { value: "9" },
    InvStartDate: "2026-01-01",
  },
  terms: {
    Id: "42",
    Name: "Due on 15th",
    Type: "DateDriven",
    DayOfMonthDue: 15,
    DueNextMonthDays: 10,
    DiscountDayOfMonth: 5,
    DiscountPercent: 2,
  },
} as const

for (const [resource, entity, nameField, path] of [
  ["customers", "Customer", "DisplayName", "customer"],
  ["vendors", "Vendor", "DisplayName", "vendor"],
  ["accounts", "Account", "Name", "account"],
  ["items", "Item", "Name", "item"],
  ["terms", "Term", "Name", "term"],
] as const) {
  test(`${resource}: reads and queries use the real entity envelopes and preserve provider fields`, async () => {
    const qb = await client()
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/${path}/42`)
      expect(url.searchParams.get("minorversion")).toBe("75")
      return { [entity]: samples[resource] }
    })
    expect(await qb[resource].get("42")).toEqual(samples[resource])
    mock((url) => {
      expect(url.pathname).toBe("/v3/company/123/query")
      expect(url.searchParams.get("query")).toBe(
        `SELECT * FROM ${entity} WHERE Active = false AND ${nameField} = 'Example' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100`
      )
      return {
        QueryResponse: { [entity]: [samples[resource]], startPosition: 1, maxResults: 1 },
        time: "2026-09-16T12:00:00Z",
      }
    })
    const page = await qb[resource].list({ active: false, name: "Example" })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toEqual(samples[resource])
    expect(page.startPosition).toBe(1)
    expect(page.maxResults).toBe(1)
    expect(page.totalCount).toBeUndefined()
  })
}

test("Preferences preserves nested settings and custom field definitions", async () => {
  const preferences = {
    Id: "1",
    CurrencyPrefs: { MultiCurrencyEnabled: true, HomeCurrency: { value: "USD" } },
    SalesFormsPrefs: {
      CustomField: [
        {
          CustomField: [
            { Name: "SalesFormsPrefs.UseSalesCustom1", Type: "BooleanType", BooleanValue: true },
          ],
        },
      ],
      DefaultTerms: { value: "3" },
    },
    OtherPrefs: { NameValue: [{ Name: "SalesFormsPrefs.DefaultItem", Value: "1" }] },
  }
  mock((url) => {
    expect(url.pathname).toBe("/v3/company/123/preferences")
    return { Preferences: preferences }
  })
  const qb = await client()
  expect(await qb.preferences.get()).toEqual(preferences)
})

test("query escapes apostrophes/backslashes and URI-encodes query values once", async () => {
  // Removal proof: remove apostrophe escaping in quoted(); the exact wire query assertion fails.
  mock((url) => {
    expect(url.searchParams.get("query")).toBe(
      "SELECT * FROM Customer WHERE Active IN (true, false) AND Id IN ('42', '43') AND DisplayName = 'Adam\\'s \\\\ Shop & Co' ORDERBY DisplayName DESC STARTPOSITION 1 MAXRESULTS 100"
    )
    return customerPage
  })
  const qb = await client()
  expect(
    (
      await qb.customers.list({
        active: "all",
        ids: ["42", "43"],
        name: "Adam's \\ Shop & Co",
        orderBy: { field: "DisplayName", direction: "DESC" },
      })
    ).items
  ).toEqual(customerPage.QueryResponse.Customer)
})

test("listAll preserves selection and sort while advancing one-based positions", async () => {
  // Removal proof: drop ...options in listAll's list call; the inactive/name checks fail.
  const positions: number[] = []
  mock((url) => {
    const query = url.searchParams.get("query") ?? ""
    expect(query).toContain("Active IN (true, false)")
    expect(query).toContain("DisplayName = 'Example'")
    expect(query).toContain("ORDERBY DisplayName DESC")
    const start = Number(query.match(/STARTPOSITION (\d+)/)?.[1])
    positions.push(start)
    return {
      QueryResponse: {
        Customer: Array.from({ length: start === 5 ? 2 : 1 }, (_, i) => ({
          Id: String(start + i),
          DisplayName: "Example",
        })),
        startPosition: start,
        maxResults: start === 5 ? 2 : 1,
      },
    }
  })
  const qb = await client()
  const result = await collect(
    qb.customers.listAll({
      startPosition: 5,
      maxResults: 2,
      active: "all",
      name: "Example",
      orderBy: { field: "DisplayName", direction: "DESC" },
    })
  )
  expect(result.map((item) => item.Id)).toEqual(["5", "6", "7"])
  expect(positions).toEqual([5, 7])
})

test("an exact full page continues to an empty envelope without fabricated totals", async () => {
  let calls = 0
  mock(() =>
    ++calls === 1
      ? {
          QueryResponse: {
            Term: [{ Id: "1", Name: "Net 30", DueDays: 30 }],
            startPosition: 1,
            maxResults: 1,
          },
        }
      : { QueryResponse: {} }
  )
  const qb = await client()
  expect(await collect(qb.terms.listAll({ maxResults: 1 }))).toHaveLength(1)
  expect(calls).toBe(2)
  expect(await qb.terms.list()).toEqual({
    items: [],
    startPosition: undefined,
    maxResults: undefined,
    totalCount: undefined,
    time: undefined,
  })
})

test("early iterator exit does not prefetch another page", async () => {
  let calls = 0
  mock(() => {
    calls++
    return {
      QueryResponse: {
        Vendor: [{ Id: "1", DisplayName: "Supplier" }],
        maxResults: 1,
        startPosition: 1,
      },
    }
  })
  const qb = await client()
  for await (const _item of qb.vendors.listAll({ maxResults: 1 })) break
  expect(calls).toBe(1)
})

test("invalid bounds and unsupported sorts fail before any request", async () => {
  let calls = 0
  mock(() => {
    calls++
    return {}
  })
  const qb = await client()
  for (const options of [
    { maxResults: 1001 },
    { maxResults: 0 },
    { startPosition: 0 },
    { startPosition: 1.5 },
    { ids: [] },
  ]) {
    await expect(qb.customers.list(options)).rejects.toThrow("[SixbQuickBooks]")
  }
  await expect(
    qb.customers.list({ orderBy: { field: "Email" } } as unknown as QuickBooksCustomerListOptions)
  ).rejects.toThrow("Unsupported query sort")
  expect(() => qb.items.get("..")).toThrow("Invalid entity ID")
  expect(calls).toBe(0)
})

test("malformed or wrong-entity responses cannot silently terminate a sync", async () => {
  const qb = await client()
  for (const body of [
    {},
    { QueryResponse: { Customer: null } },
    { QueryResponse: { Customer: {} } },
    { QueryResponse: { Vendor: [] } },
    { QueryResponse: { maxResults: 1 } },
    { QueryResponse: { Customer: [{ Name: "Missing ID" }] } },
    { QueryResponse: { startPosition: 2 } },
  ]) {
    mock(() => body)
    await expect(qb.customers.list()).rejects.toThrow("[SixbQuickBooks]")
  }
  mock(() => ({ Customer: { Id: "wrong", DisplayName: "Wrong" } }))
  await expect(qb.customers.get("42")).rejects.toThrow("does not match")
})

test("a repeated full page fails instead of iterating forever", async () => {
  // Removal proof: remove the signature comparison in listAll; the second next() resolves instead.
  mock(() => ({ QueryResponse: { Item: [{ Id: "42", Name: "Widget" }] } }))
  const qb = await client()
  const iterator = qb.items.listAll({ maxResults: 1 })[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  await expect(iterator.next()).rejects.toThrow("repeated a page")
})

test("inventory, service and bundle details remain provider-shaped", async () => {
  const items = [
    samples.items,
    { Id: "43", Name: "Service", Type: "Service", UnitPrice: 50 },
    {
      Id: "44",
      Name: "Bundle",
      Type: "Group",
      ItemGroupDetail: { ItemGroupLine: [{ ItemRef: { value: "42" }, Qty: 2 }] },
    },
  ]
  mock(() => ({ QueryResponse: { Item: items } }))
  expect((await (await client()).items.list()).items).toEqual(items)
})
