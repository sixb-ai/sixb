import { afterEach, expect, test } from "bun:test"
import { QuickBooksCdcLimitError, type QuickBooksCdcOptions, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const options: QuickBooksCdcOptions = {
  entities: ["Customer", "Invoice"],
  changedSince: new Date(Date.now() - 60_000),
}
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
    account: { id: "123", label: "company" },
    signal: new AbortController().signal,
    tokenSource: {
      async get() {
        return { accessToken: "token", invalidate() {} }
      },
    },
  })
}
function mock(body: unknown, check?: (url: URL) => void) {
  globalThis.fetch = ((url) => {
    check?.(new URL(String(url)))
    return Promise.resolve(Response.json(body))
  }) as typeof fetch
}
function response<const T extends readonly unknown[]>(groups: T) {
  return { CDCResponse: [{ QueryResponse: groups }], time: new Date().toISOString() }
}

test("CDC uses company-scoped endpoint and retains typed records, deletions and provider metadata", async () => {
  const body = response([
    { Customer: [{ Id: "1", DisplayName: "Inactive", Active: false }], maxResults: 1 },
    {
      Invoice: [
        {
          Id: "2",
          status: "Deleted",
          domain: "QBO",
          MetaData: { LastUpdatedTime: options.changedSince.toISOString() },
        },
      ],
      totalCount: 1,
    },
  ])
  mock(body, (url) => {
    expect(url.pathname).toBe("/v3/company/123/cdc")
    expect(url.searchParams.get("entities")).toBe("Customer,Invoice")
    expect(url.searchParams.get("changedSince")).toBe(options.changedSince.toISOString())
    expect(url.searchParams.get("minorversion")).toBe("75")
  })
  const result = await (await client()).cdc.get(options)
  expect(result).toEqual(body)
  const change = result.CDCResponse[0]?.QueryResponse[1]?.Invoice?.[0]
  if (change?.status !== "Deleted") throw new Error("Expected deletion marker")
  expect(change.Id).toBe("2")
})

test("CDC accepts explicit empty groups and rejects malformed or unexpected data", async () => {
  const qb = await client()
  const empty = response([{ totalCount: 0 }])
  mock(empty)
  expect(await qb.cdc.get(options)).toEqual(empty)
  for (const body of [
    {},
    { CDCResponse: [{}], time: new Date().toISOString() },
    response([{ Vendor: [] }]),
    response([{ Invoice: null }]),
    response([{ totalCount: 1 }]),
    response([{ Fault: { Error: [] } }]),
    response([{ Invoice: [{ status: "Deleted" }] }]),
  ]) {
    mock(body)
    await expect(qb.cdc.get(options)).rejects.toThrow("[SixbQuickBooks]")
  }
})

test("CDC validates entity selection and 30-day lookback before fetch", async () => {
  let calls = 0
  mock({}, () => {
    calls++
  })
  const qb = await client()
  for (const value of [
    { ...options, entities: [] },
    { ...options, entities: ["Invoice", "Invoice"] },
    // QuickBooks fails CDC for these (4001/5030) or returns rows without entity IDs.
    { ...options, entities: ["TaxAgency"] },
    { ...options, entities: ["TaxClassification"] },
    { ...options, entities: ["TaxPayment"] },
    { ...options, entities: ["Exchangerate"] },
    { ...options, entities: ["Preferences"] },
    { ...options, changedSince: new Date(Date.now() - 31 * 86400_000) },
    { ...options, changedSince: new Date(Date.now() + 60_000) },
    { ...options, changedSince: new Date(NaN) },
  ])
    await expect(qb.cdc.get(value as QuickBooksCdcOptions)).rejects.toThrow("[SixbQuickBooks]")
  expect(calls).toBe(0)
})

test("CDC cap counts across entity groups and never returns a successful truncated sync", async () => {
  // Removal proof: remove count >= 1000 in createCdcResource; this rejection becomes a success.
  const records = Array.from({ length: 500 }, (_, id) => ({
    Id: String(id),
    DisplayName: "Example",
  }))
  const body = response([{ Customer: records }, { Invoice: records }])
  mock(body)
  const qb = await client()
  try {
    await qb.cdc.get(options)
    throw new Error("expected limit error")
  } catch (error) {
    expect(error).toBeInstanceOf(QuickBooksCdcLimitError)
    if (error instanceof QuickBooksCdcLimitError) expect(error.response).toEqual(body)
  }
  mock(response([{ Invoice: records.slice(0, 499) }, { Customer: records }]))
  await qb.cdc.get(options)
  mock(response([{ Invoice: [{ Id: "1" }], totalCount: 1000 }]))
  await expect(qb.cdc.get(options)).rejects.toBeInstanceOf(QuickBooksCdcLimitError)
  mock(
    response([
      { Invoice: [{ Id: "1" }], totalCount: 500 },
      { Customer: [{ Id: "2" }], totalCount: 500 },
    ])
  )
  await expect(qb.cdc.get(options)).rejects.toBeInstanceOf(QuickBooksCdcLimitError)
})

test("CDC accepts every newly supported entity and keeps their typed groups", async () => {
  const entities = [
    "Attachable",
    "Budget",
    "Class",
    "CompanyCurrency",
    "CustomerType",
    "Department",
    "Employee",
    "PaymentMethod",
    "TaxCode",
    "TaxRate",
    "CreditCardPayment",
    "Deposit",
    "Estimate",
    "InventoryAdjustment",
    "JournalEntry",
    "Purchase",
    "PurchaseOrder",
    "RefundReceipt",
    "ReimburseCharge",
    "SalesReceipt",
    "TimeActivity",
    "Transfer",
  ] as const
  const body = response(entities.map((entity, index) => ({ [entity]: [{ Id: String(index) }] })))
  mock(body, (url) => {
    expect(url.searchParams.get("entities")).toBe(entities.join(","))
  })
  const result = await (await client()).cdc.get({ ...options, entities })
  expect(result).toEqual(body)
  expect(result.CDCResponse[0]?.QueryResponse[12]?.Estimate?.[0]?.Id).toBe("12")
})

test("CDC keeps recurring template wrappers, including wrapped deletions", async () => {
  // Shapes observed live: create returned { Bill: {...} }; delete returned
  // { Bill: { Id, status: "Deleted", MetaData } } inside the RecurringTransaction group.
  const body = response([
    {
      RecurringTransaction: [
        { Bill: { Id: "200", SyncToken: "0", RecurringInfo: { Name: "Lease", Active: true } } },
        {
          Bill: {
            Id: "201",
            status: "Deleted",
            domain: "QBO",
            MetaData: { LastUpdatedTime: new Date().toISOString() },
          },
        },
      ],
      maxResults: 2,
    },
  ])
  mock(body)
  const qb = await client()
  const result = await qb.cdc.get({ ...options, entities: ["RecurringTransaction"] })
  const changes = result.CDCResponse[0]?.QueryResponse[0]?.RecurringTransaction ?? []
  const deleted = changes[1]
  if (!deleted || !("Bill" in deleted) || deleted.Bill.status !== "Deleted")
    throw new Error("Expected a wrapped deletion")
  expect(deleted.Bill.Id).toBe("201")
  // Removal proof: validate RecurringTransaction records like other entities (top-level Id);
  // the wrapped records above are then rejected as invalid CDC records.
  for (const record of [
    { Id: "200" },
    { Bill: { Id: "200" }, Invoice: { Id: "201" } },
    { Bill: { Id: "200", status: "Voided" } },
    { Bill: {} },
  ]) {
    mock(response([{ RecurringTransaction: [record] }]))
    await expect(qb.cdc.get({ ...options, entities: ["RecurringTransaction"] })).rejects.toThrow(
      "Invalid CDC record"
    )
  }
})
