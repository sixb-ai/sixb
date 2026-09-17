import { afterEach, expect, test } from "bun:test"
import { QuickBooksApiError, type QuickBooksClient, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
async function client(): Promise<QuickBooksClient> {
  return quickbooks({
    clientId: "client",
    clientSecret: "secret",
    environment: "sandbox",
    retry: { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "c",
    signal: new AbortController().signal,
    account: { id: "123", label: "company" },
    tokenSource: {
      async get() {
        return { accessToken: "access", invalidate() {} }
      },
    },
  })
}
function mock(fn: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(fn(new URL(String(input)), init ?? {}))) as typeof fetch
}
const identity = { Id: "42", SyncToken: "0" }
const options = { requestId: "persisted-key" }
const sales = [
  {
    Amount: 10,
    DetailType: "SalesItemLineDetail" as const,
    SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 1, UnitPrice: 10 },
  },
]
const expenses = [
  {
    Amount: 10,
    DetailType: "AccountBasedExpenseLineDetail" as const,
    AccountBasedExpenseLineDetail: { AccountRef: { value: "8" } },
  },
]
const allocation = [{ Amount: 10, LinkedTxn: [{ TxnId: "90", TxnType: "Bill" }] }]
const payment = { CustomerRef: { value: "7" }, TotalAmt: 10 }
const credit = { CustomerRef: { value: "7" }, Line: sales }
const bill = { VendorRef: { value: "9" }, Line: expenses }
const check = {
  VendorRef: { value: "9" },
  TotalAmt: 10,
  PayType: "Check" as const,
  CheckPayment: { BankAccountRef: { value: "5" } },
  Line: allocation,
}
const card = {
  VendorRef: { value: "9" },
  TotalAmt: 10,
  PayType: "CreditCard" as const,
  CreditCardPayment: { CCAccountRef: { value: "6" } },
  Line: allocation,
}
const service = { Name: "Service", Type: "Service" as const, IncomeAccountRef: { value: "8" } }
const inventory = {
  ...service,
  Type: "Inventory" as const,
  ExpenseAccountRef: { value: "9" },
  AssetAccountRef: { value: "10" },
  TrackQtyOnHand: true as const,
  QtyOnHand: 0,
  InvStartDate: "2026-09-01",
}

// Synthetic requests based on Intuit's entity references. In particular, voiding Payment and
// BillPayment differs from Invoice: changing include=void to operation=void in either resource
// reproduces a failure in the "void uses sparse update" tests below.
const creates: {
  name: string
  entity: string
  input: object
  run: (qb: QuickBooksClient) => Promise<unknown>
}[] = [
  {
    name: "unapplied payment",
    entity: "Payment",
    input: payment,
    run: (q) => q.payments.create(payment, options),
  },
  {
    name: "credit memo",
    entity: "CreditMemo",
    input: credit,
    run: (q) => q.creditMemos.create(credit, options),
  },
  { name: "bill", entity: "Bill", input: bill, run: (q) => q.bills.create(bill, options) },
  {
    name: "vendor credit",
    entity: "VendorCredit",
    input: bill,
    run: (q) => q.vendorCredits.create(bill, options),
  },
  {
    name: "check bill payment",
    entity: "BillPayment",
    input: check,
    run: (q) => q.billPayments.create(check, options),
  },
  {
    name: "card bill payment",
    entity: "BillPayment",
    input: card,
    run: (q) => q.billPayments.create(card, options),
  },
  {
    name: "account",
    entity: "Account",
    input: { Name: "Income", AccountType: "Income" },
    run: (q) => q.accounts.create({ Name: "Income", AccountType: "Income" }, options),
  },
  {
    name: "service item",
    entity: "Item",
    input: service,
    run: (q) => q.items.create(service, options),
  },
  {
    name: "non-inventory item",
    entity: "Item",
    input: { ...service, Type: "NonInventory" },
    run: (q) => q.items.create({ ...service, Type: "NonInventory" }, options),
  },
  {
    name: "inventory item",
    entity: "Item",
    input: inventory,
    run: (q) => q.items.create(inventory, options),
  },
  {
    name: "category",
    entity: "Item",
    input: { Name: "Category", Type: "Category" },
    run: (q) => q.items.create({ Name: "Category", Type: "Category" }, options),
  },
  {
    name: "net term",
    entity: "Term",
    input: { Name: "Due now", DueDays: 0 },
    run: (q) => q.terms.create({ Name: "Due now", DueDays: 0 }, options),
  },
  {
    name: "date-driven term",
    entity: "Term",
    input: { Name: "Due 15th", DayOfMonthDue: 15 },
    run: (q) => q.terms.create({ Name: "Due 15th", DayOfMonthDue: 15 }, options),
  },
]
for (const scenario of creates) {
  test(`create ${scenario.name} uses the company-scoped provider envelope and exact writable payload`, async () => {
    const result = { ...identity, ...scenario.input, ProviderExtension: "preserved" }
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${scenario.entity.toLowerCase()}`)
      expect(url.searchParams.get("minorversion")).toBe("75")
      expect(url.searchParams.get("requestid")).toBe(options.requestId)
      expect(init.method).toBe("POST")
      expect(new Headers(init.headers).get("content-type")).toBe("application/json")
      expect(JSON.parse(String(init.body))).toEqual(scenario.input)
      return Response.json({ [scenario.entity]: result })
    })
    expect(await scenario.run(await client())).toEqual(result)
  })
}

test("updates carry required party/line fields, caller revisions, and explicit sparse behavior", async () => {
  const q = await client()
  const cases = [
    {
      entity: "Payment",
      input: { ...identity, Line: [] },
      run: () => q.payments.update({ ...identity, Line: [] }, options),
    },
    {
      entity: "CreditMemo",
      input: { ...identity, ...credit },
      run: () => q.creditMemos.update({ ...identity, ...credit }, options),
    },
    {
      entity: "Bill",
      input: { ...identity, ...bill },
      run: () => q.bills.update({ ...identity, ...bill }, options),
    },
    {
      entity: "VendorCredit",
      input: { ...identity, ...bill },
      run: () => q.vendorCredits.update({ ...identity, ...bill }, options),
    },
    {
      entity: "BillPayment",
      input: { ...identity, ...card },
      run: () => q.billPayments.update({ ...identity, ...card }, options),
    },
    {
      entity: "Account",
      input: { ...identity, Description: "Changed" },
      run: () => q.accounts.update({ ...identity, Description: "Changed" }, options),
    },
    {
      entity: "Item",
      input: { ...identity, Type: "Service", UnitPrice: 0 },
      run: () => q.items.update({ ...identity, Type: "Service", UnitPrice: 0 }, options),
    },
    {
      entity: "Term",
      input: { ...identity, DueDays: 0 },
      run: () => q.terms.update({ ...identity, DueDays: 0 }, options),
    },
    {
      entity: "CompanyInfo",
      input: { ...identity, CompanyName: "Changed" },
      run: () => q.companyInfo.update({ ...identity, CompanyName: "Changed" }, options),
    },
    {
      entity: "Preferences",
      input: { ...identity, ReportPrefs: { ReportBasis: "Cash" } },
      run: () =>
        q.preferences.update({ ...identity, ReportPrefs: { ReportBasis: "Cash" } }, options),
    },
  ]
  for (const c of cases) {
    let calls = 0
    mock((url, init) => {
      calls++
      expect(url.pathname).toBe(`/v3/company/123/${c.entity.toLowerCase()}`)
      expect(init.method).toBe("POST")
      expect(JSON.parse(String(init.body))).toEqual({
        ...c.input,
        sparse: true,
      })
      return Response.json({ [c.entity]: { ...identity, SyncToken: "1" } })
    })
    expect(await c.run()).toHaveProperty("SyncToken", "1")
    expect(calls).toBe(1) // No hidden read/merge or revision substitution.
  }
})

test("all remaining transaction deletes send only the caller's revision", async () => {
  const qb = await client()
  for (const [resource, entity] of [
    ["payments", "Payment"],
    ["creditMemos", "CreditMemo"],
    ["bills", "Bill"],
    ["billPayments", "BillPayment"],
    ["vendorCredits", "VendorCredit"],
  ] as const) {
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${entity.toLowerCase()}`)
      expect(url.searchParams.get("operation")).toBe("delete")
      expect(JSON.parse(String(init.body))).toEqual(identity)
      return Response.json({ [entity]: { Id: identity.Id, status: "Deleted" } })
    })
    const row = { ...identity, TotalAmt: 100 }
    expect(await qb[resource].delete(row)).toEqual({ Id: identity.Id, status: "Deleted" })
  }
})

for (const [resource, entity] of [
  ["payments", "Payment"],
  ["billPayments", "BillPayment"],
] as const) {
  test(`${entity} void uses sparse update and include=void`, async () => {
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${entity.toLowerCase()}`)
      expect(url.searchParams.get("operation")).toBe("update")
      expect(url.searchParams.get("include")).toBe("void")
      expect(JSON.parse(String(init.body))).toEqual({ ...identity, sparse: true })
      return Response.json({ [entity]: { ...identity, TotalAmt: 0, Line: [] } })
    })
    expect((await (await client())[resource].void(identity)).TotalAmt).toBe(0)
  })
}

test("payment receipts require a recipient while credit memos can use stored BillEmail", async () => {
  const qb = await client()
  for (const entity of ["Payment", "CreditMemo"]) {
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${entity.toLowerCase()}/42/send`)
      expect(url.searchParams.get("sendTo")).toBe("a+b@example.com")
      expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream")
      expect(init.body).toBe("")
      return Response.json({ [entity]: identity })
    })
    const resource = entity === "Payment" ? qb.payments : qb.creditMemos
    await resource.send("42", { sendTo: "a+b@example.com" })
  }
  mock((url) => {
    expect(url.searchParams.has("sendTo")).toBe(false)
    return Response.json({ CreditMemo: identity })
  })
  await qb.creditMemos.send("42")
})

test("reference activation sends minimal payloads and retains the item discriminator", async () => {
  const qb = await client()
  for (const [name, entity] of [
    ["accounts", "Account"],
    ["terms", "Term"],
  ] as const) {
    for (const active of [false, true]) {
      mock((_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ ...identity, Active: active, sparse: true })
        return Response.json({ [entity]: { ...identity, Active: active } })
      })
      expect((await qb[name][active ? "reactivate" : "deactivate"](identity)).Active).toBe(active)
    }
  }
  for (const active of [false, true]) {
    mock((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({
        ...identity,
        Type: "Service",
        Active: active,
        sparse: true,
      })
      return Response.json({ Item: { ...identity, Active: active } })
    })
    expect(
      (await qb.items[active ? "reactivate" : "deactivate"]({ ...identity, Type: "Service" }))
        .Active
    ).toBe(active)
  }
})

test("each new write resource preserves faults and never replays even under custom retry policies", async () => {
  const qb = await client()
  for (const scenario of creates) {
    let calls = 0
    mock(() => {
      calls++
      return Response.json(
        { Fault: { type: "ValidationFault", Error: [{ code: "5010", Detail: "Stale Object" }] } },
        { status: 400, headers: { intuit_tid: "trace" } }
      )
    })
    const error = await scenario.run(qb).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(QuickBooksApiError)
    expect(error).toHaveProperty("errors.0.code", "5010")
    expect(error).toHaveProperty("writeRequestId", options.requestId)
    expect(error).toHaveProperty("requestId", "trace")
    expect(calls).toBe(1)
  }
})

test("invalid required fields, discriminators and amounts reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(qb.payments.create({ ...payment, TotalAmt: -1 })).rejects.toThrow("TotalAmt")
  await expect(qb.payments.send("42", { sendTo: "" })).rejects.toThrow("sendTo")
  await expect(
    qb.payments.update({ ...identity, Line: [{ Amount: 1, LinkedTxn: [] }] })
  ).rejects.toThrow("LinkedTxn")
  // @ts-expect-error Required even for sparse Bill updates (verified against sandbox error 2020).
  await expect(qb.bills.update({ ...identity, PrivateNote: "missing lines" })).rejects.toThrow(
    "VendorRef"
  )
  await expect(qb.bills.create({ ...bill, Line: [] })).rejects.toThrow("Line")
  await expect(qb.creditMemos.create({ ...credit, Line: [] })).rejects.toThrow("Line")
  await expect(qb.vendorCredits.create({ ...bill, VendorRef: { value: "" } })).rejects.toThrow(
    "VendorRef"
  )
  await expect(
    // @ts-expect-error A check cannot contain credit-card payment detail.
    qb.billPayments.create({ ...check, CreditCardPayment: card.CreditCardPayment })
  ).rejects.toThrow("PayType")
  // @ts-expect-error Account type or subtype is required.
  await expect(qb.accounts.create({ Name: "Missing type" })).rejects.toThrow("AccountType")
  // @ts-expect-error Bundle creation is not supported by Intuit.
  await expect(qb.items.create({ Name: "Bundle", Type: "Group" })).rejects.toThrow("Type")
  // @ts-expect-error Categories cannot be activated/deactivated through this method.
  await expect(qb.items.deactivate({ ...identity, Type: "Category" })).rejects.toThrow("activation")
  await expect(qb.items.update({ ...identity, Type: "Inventory", QtyOnHand: 1 })).rejects.toThrow(
    "InvStartDate"
  )
  await expect(qb.terms.create({ Name: "Invalid day", DayOfMonthDue: 32 })).rejects.toThrow(
    "DayOfMonthDue"
  )
  // @ts-expect-error A term needs one due-date rule.
  await expect(qb.terms.create({ Name: "Missing due date" })).rejects.toThrow("DueDays")
  await expect(qb.terms.update({ ...identity, DueDays: 10, DiscountPercent: 101 })).rejects.toThrow(
    "DiscountPercent"
  )
  await expect(qb.preferences.update({ ...identity, SyncToken: "" })).rejects.toThrow("SyncToken")
  await expect(qb.companyInfo.update({ ...identity, CompanyName: "" })).rejects.toThrow(
    "CompanyName"
  )
  expect(calls).toBe(0)
})

// Reproduce the guard proof by removing the corresponding early checks in terms.ts and
// preferences.ts: this test fails because invalid writes then reach the mocked network.
// Live Intuit returned 6000 for a name-only Term edit, and a SalesFormsPrefs no-op cleared
// DefaultCustomerMessage while direct restoration returned 2010 (September 2026, minor 75).
test("live-discovered term and sales-form constraints reject before sending", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  // @ts-expect-error A due-date rule is required when editing a term.
  await expect(qb.terms.update({ ...identity, Name: "Renamed" })).rejects.toThrow("DueDays")
  await expect(
    // @ts-expect-error Sales-form preference edits have provider-side data loss.
    qb.preferences.update({ ...identity, SalesFormsPrefs: { AllowServiceDate: true } })
  ).rejects.toThrow("SalesFormsPrefs")
  await expect(
    // @ts-expect-error The extension group is read-only in this connector.
    qb.preferences.update({ ...identity, OtherPrefs: { NameValue: [] } })
  ).rejects.toThrow("OtherPrefs")
  expect(calls).toBe(0)
})

test("Preferences HTTP 200 Fault is an API failure, with recovery and trace details", async () => {
  mock(() =>
    Response.json(
      {
        Fault: {
          Error: [
            {
              Message: "A business validation error has occurred while processing your request",
              Detail:
                "You can't turn off Inventory Tracking as long as you have products of type Inventory.",
            },
          ],
        },
      },
      { headers: { intuit_tid: "preferences-trace" } }
    )
  )
  const qb = await client()
  const error = await qb.preferences
    .update({ ...identity, ProductAndServicesPrefs: { QuantityOnHand: false } }, options)
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(QuickBooksApiError)
  expect(error).toHaveProperty("status", 200)
  expect(error).toHaveProperty("requestId", "preferences-trace")
  expect(error).toHaveProperty("writeRequestId", options.requestId)
  expect(error).toHaveProperty(
    "errors.0.Detail",
    "You can't turn off Inventory Tracking as long as you have products of type Inventory."
  )
})
