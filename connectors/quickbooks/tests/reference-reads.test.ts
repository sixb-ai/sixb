import { afterEach, expect, test } from "bun:test"
import {
  type QuickBooksCompanyCurrencyListOptions,
  type QuickBooksExchangeRateKey,
  type QuickBooksTaxAgencyListOptions,
  type QuickBooksTaxClassificationListOptions,
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

// Synthetic partial samples shaped like Intuit's entity references; not sandbox captures.
const samples = {
  customerTypes: { Id: "42", Name: "Residential", Active: true },
  taxCodes: {
    Id: "42",
    Name: "County",
    Active: true,
    Taxable: true,
    TaxGroup: true,
    SalesTaxRateList: {
      TaxRateDetail: [
        { TaxRateRef: { value: "3" }, TaxTypeApplicable: "TaxOnAmount", TaxOrder: 0 },
      ],
    },
    PurchaseTaxRateList: { TaxRateDetail: [] },
  },
  taxRates: { Id: "42", Name: "County", Active: true, RateValue: 8.125, AgencyRef: { value: "1" } },
  budgets: {
    Id: "42",
    Name: "FY2026",
    Active: true,
    BudgetType: "ProfitAndLoss",
    BudgetEntryType: "Monthly",
    BudgetDetail: [{ BudgetDate: "2026-01-01", Amount: 1250.5, AccountRef: { value: "8" } }],
  },
} as const

for (const [resource, entity, path] of [
  ["customerTypes", "CustomerType", "customertype"],
  ["taxCodes", "TaxCode", "taxcode"],
  ["taxRates", "TaxRate", "taxrate"],
  ["budgets", "Budget", "budget"],
] as const) {
  test(`${resource}: name-list reads keep Active selection, name and modification filters`, async () => {
    const qb = await client()
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/${path}/42`)
      return { [entity]: samples[resource] }
    })
    expect(await qb[resource].get("42")).toEqual(samples[resource])
    const queries: string[] = []
    mock((url) => {
      queries.push(url.searchParams.get("query") ?? "")
      return { QueryResponse: { [entity]: [samples[resource]], startPosition: 1, maxResults: 1 } }
    })
    expect(
      (await qb[resource].list({ active: "all", name: "A'B", updatedSince: since })).items
    ).toEqual([samples[resource]])
    expect(queries).toEqual([
      `SELECT * FROM ${entity} WHERE Active IN (true, false) AND Name = 'A\\'B' AND MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100`,
    ])
  })
}

test("tax codes always send an Active predicate so pseudo-codes cannot overflow a page", async () => {
  // Live sandbox: without an Active predicate, page one adds TAX/NON/CustomSalesTax beyond
  // MAXRESULTS and later offsets skip numeric codes. Removal proof: make listEntities omit the
  // Active clause for "all"; this exact query assertion fails.
  const queries: string[] = []
  mock((url) => {
    queries.push(url.searchParams.get("query") ?? "")
    return { QueryResponse: {} }
  })
  const qb = await client()
  await qb.taxCodes.list({ active: "all", maxResults: 2 })
  await qb.taxCodes.list()
  expect(queries).toEqual([
    "SELECT * FROM TaxCode WHERE Active IN (true, false) ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 2",
    "SELECT * FROM TaxCode WHERE Active = true ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ])
  mock(() => ({
    QueryResponse: {
      TaxCode: [{ Id: "TAX" }, { Id: "NON" }, { Id: "2" }],
      startPosition: 1,
      maxResults: 3,
    },
  }))
  await expect(qb.taxCodes.list({ maxResults: 2 })).rejects.toThrow("Invalid TaxCode query results")
})

test("tax agencies have no Active predicate and currencies have no name field", async () => {
  const queries: string[] = []
  mock((url) => {
    queries.push(url.searchParams.get("query") ?? "")
    return { QueryResponse: {} }
  })
  const qb = await client()
  await qb.taxAgencies.list({ name: "Board of Equalization", orderBy: { field: "Name" } })
  await qb.companyCurrencies.list({ active: false, ids: ["EUR"] })
  expect(queries).toEqual([
    "SELECT * FROM TaxAgency WHERE Name = 'Board of Equalization' ORDERBY Name ASC STARTPOSITION 1 MAXRESULTS 100",
    "SELECT * FROM CompanyCurrency WHERE Active = false AND Id IN ('EUR') ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
  ])
  await expect(
    qb.taxAgencies.list({ active: true } as unknown as QuickBooksTaxAgencyListOptions)
  ).rejects.toThrow("Unsupported list option: active")
  await expect(
    qb.companyCurrencies.list({ name: "EUR" } as unknown as QuickBooksCompanyCurrencyListOptions)
  ).rejects.toThrow("Unsupported list option: name")
  await expect(
    qb.companyCurrencies.list({
      orderBy: { field: "Code" },
    } as unknown as QuickBooksCompanyCurrencyListOptions)
  ).rejects.toThrow("Unsupported query sort")
  expect(queries).toHaveLength(2)
})

test("tax classifications are read in one unpaged response with hierarchy filters", async () => {
  // Removal proof: route list through the paged readers; the over-1,000-row page is rejected.
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    Id: `EUC-${index}-V1`,
    Code: `EUC-${index}`,
    Name: `Category ${index}`,
    Level: "3",
    ParentRef: { value: "9" },
    ApplicableTo: ["Inventory", "NonInventory"],
  }))
  const queries: string[] = []
  mock((url) => {
    if (url.pathname.endsWith("/taxclassification/EUC-1-V1")) return { TaxClassification: rows[1] }
    queries.push(url.searchParams.get("query") ?? "")
    return { QueryResponse: { TaxClassification: rows } }
  })
  const qb = await client()
  expect(await qb.taxClassifications.get("EUC-1-V1")).toEqual(rows[1])
  expect(await collect(qb.taxClassifications.listAll())).toHaveLength(1200)
  const page = await qb.taxClassifications.list({ level: "3", parentId: "9", name: "A" })
  expect(page.items).toHaveLength(1200)
  expect(queries).toEqual([
    "SELECT * FROM TaxClassification",
    "SELECT * FROM TaxClassification WHERE Name = 'A' AND Level = '3' AND ParentRef = '9'",
  ])
  await expect(
    qb.taxClassifications.list({
      maxResults: 10,
    } as unknown as QuickBooksTaxClassificationListOptions)
  ).rejects.toThrow("Unsupported tax classification list option: maxResults")
})

test("exchange rates are read by currency and date, and listed without sorting or IDs", async () => {
  const rate = {
    SourceCurrencyCode: "EUR",
    TargetCurrencyCode: "USD",
    Rate: 1.115076,
    AsOfDate: "2026-11-08",
    MetaData: { LastUpdatedTime: "2026-11-08T08:01:12-08:00" },
  }
  const qb = await client()
  mock((url) => {
    expect(url.pathname).toBe("/v3/company/123/exchangerate")
    expect(url.searchParams.get("sourcecurrencycode")).toBe("EUR")
    expect(url.searchParams.get("asofdate")).toBe("2026-11-08")
    return { ExchangeRate: rate }
  })
  expect(await qb.exchangeRates.get({ sourceCurrencyCode: "EUR", asOfDate: "2026-11-08" })).toEqual(
    rate
  )
  mock(() => ({ ExchangeRate: { ...rate, AsOfDate: "2026-11-07" } }))
  await expect(
    qb.exchangeRates.get({ sourceCurrencyCode: "EUR", asOfDate: "2026-11-08" })
  ).rejects.toThrow("does not match")
  const queries: string[] = []
  mock((url) => {
    const query = url.searchParams.get("query") ?? ""
    queries.push(query)
    // The query entity is Exchangerate; the response array is ExchangeRate.
    return {
      QueryResponse: query.includes("STARTPOSITION 1 ")
        ? { ExchangeRate: [rate], startPosition: 1, maxResults: 1, totalCount: 1 }
        : {},
    }
  })
  expect(await collect(qb.exchangeRates.listAll({ updatedSince: since, maxResults: 1 }))).toEqual([
    rate,
  ])
  expect(queries).toEqual([
    "SELECT * FROM Exchangerate WHERE MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' STARTPOSITION 1 MAXRESULTS 1",
    "SELECT * FROM Exchangerate WHERE MetaData.LastUpdatedTime >= '2026-09-01T00:00:00.000Z' STARTPOSITION 2 MAXRESULTS 1",
  ])
  mock(() => ({ QueryResponse: { ExchangeRate: [{ Rate: 1 }] } }))
  await expect(qb.exchangeRates.list()).rejects.toThrow("Invalid ExchangeRate response")
})

test("invalid exchange-rate keys fail before any request", async () => {
  let calls = 0
  mock(() => {
    calls++
    return {}
  })
  const qb = await client()
  for (const key of [
    { sourceCurrencyCode: "eur" },
    { sourceCurrencyCode: "EURO" },
    { sourceCurrencyCode: "EUR", asOfDate: "2026-02-30" },
    { sourceCurrencyCode: "EUR", currency: "USD" },
  ])
    await expect(qb.exchangeRates.get(key as unknown as QuickBooksExchangeRateKey)).rejects.toThrow(
      "[SixbQuickBooks]"
    )
  await expect(qb.exchangeRates.list({ maxResults: 0 })).rejects.toThrow("maxResults")
  expect(calls).toBe(0)
})
