import { afterEach, expect, test } from "bun:test"
import { QuickBooksApiError, type QuickBooksRefundReceiptCreate, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
async function client(hostileRetries = true) {
  return quickbooks({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    // A hostile custom policy must still never replay writes.
    retry: hostileRetries
      ? { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 }
      : { maxRetries: 0 },
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
function mock(handler: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(new URL(String(input)), init ?? {}))) as typeof fetch
}
const identity = { Id: "42", SyncToken: "1" }
const Line = [
  {
    Amount: 12,
    DetailType: "SalesItemLineDetail" as const,
    SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 1, UnitPrice: 12 },
  },
]
const receipt = { Line, DepositToAccountRef: { value: "35" }, PaymentRefNum: "1042" }
const refund = { CustomerRef: { value: "9" }, Line, DepositToAccountRef: { value: "35" } }
const pdf = new Uint8Array([37, 80, 68, 70, 45, 0, 255])

for (const [resource, entity, path] of [
  ["salesReceipts", "SalesReceipt", "salesreceipt"],
  ["refundReceipts", "RefundReceipt", "refundreceipt"],
  ["creditMemos", "CreditMemo", "creditmemo"],
] as const) {
  test(`${resource}: reads, customer filter and PDF use the ${entity} routes`, async () => {
    const qb = await client(false)
    const sample = { ...identity, ...refund, TotalAmt: 12, ProviderExtension: "kept" }
    mock((url, init) => {
      if (url.pathname.endsWith("/pdf")) {
        expect(url.pathname).toBe(`/v3/company/123/${path}/42/pdf`)
        expect(new Headers(init.headers).get("Accept")).toBe("application/pdf")
        return new Response(pdf, { headers: { "Content-Type": "application/pdf" } })
      }
      if (url.pathname.endsWith("/query")) {
        expect(url.searchParams.get("query")).toBe(
          `SELECT * FROM ${entity} WHERE CustomerRef IN ('9') ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100`
        )
        return Response.json({ QueryResponse: { [entity]: [sample] } })
      }
      expect(url.pathname).toBe(`/v3/company/123/${path}/42`)
      return Response.json({ [entity]: sample })
    })
    expect(await qb[resource].get("42")).toEqual(sample)
    expect(
      (
        await qb[resource].list({
          customerIds: ["9"],
          orderBy: { field: "TxnDate", direction: "DESC" },
        })
      ).items
    ).toEqual([sample])
    expect(await qb[resource].downloadPdf("42")).toEqual(pdf)
  })
}

test("sales receipt writes: create, sparse update, include=void, delete and send", async () => {
  const calls: { path: string; query: Record<string, string>; body: unknown }[] = []
  mock((url, init) => {
    const query = Object.fromEntries(url.searchParams)
    delete query.minorversion
    delete query.requestid
    calls.push({
      path: url.pathname.replace("/v3/company/123/", ""),
      query,
      body: init.body === "" ? "" : JSON.parse(String(init.body)),
    })
    return Response.json({
      SalesReceipt:
        url.searchParams.get("operation") === "delete"
          ? { Id: "42", status: "Deleted" }
          : { ...identity, EmailStatus: "EmailSent" },
    })
  })
  const qb = await client()
  await qb.salesReceipts.create(receipt)
  await qb.salesReceipts.update({ ...identity, PrivateNote: "Paid in full" })
  await qb.salesReceipts.void({ ...identity, ...receipt })
  await qb.salesReceipts.delete(identity)
  await qb.salesReceipts.send("42", { sendTo: "receipts@example.com" })
  expect(calls).toEqual([
    { path: "salesreceipt", query: {}, body: receipt },
    {
      path: "salesreceipt",
      query: {},
      body: { ...identity, PrivateNote: "Paid in full", sparse: true },
    },
    {
      path: "salesreceipt",
      query: { operation: "update", include: "void" },
      body: { ...identity, sparse: true },
    },
    { path: "salesreceipt", query: { operation: "delete" }, body: identity },
    { path: "salesreceipt/42/send", query: { sendTo: "receipts@example.com" }, body: "" },
  ])
})

// Live sandbox: refundreceipt?operation=update&include=void returned HTTP 200 without voiding
// (TotalAmt unchanged); operation=void zeroed it. Removal proof: switch refundReceipts.void to
// voidByUpdate and this exact operation assertion fails.
test("refund receipt void uses operation=void, unlike sales receipts", async () => {
  const calls: { query: Record<string, string>; body: unknown }[] = []
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/refundreceipt")
    calls.push({
      query: { operation: url.searchParams.get("operation") ?? "" },
      body: JSON.parse(String(init.body)),
    })
    return Response.json({ RefundReceipt: { ...identity, TotalAmt: 0 } })
  })
  const qb = await client()
  await qb.refundReceipts.create(refund)
  await qb.refundReceipts.update({ ...identity, PrivateNote: "Changed" })
  expect((await qb.refundReceipts.void({ ...identity, ...refund })).TotalAmt).toBe(0)
  expect(calls).toEqual([
    { query: { operation: "" }, body: refund },
    { query: { operation: "" }, body: { ...identity, PrivateNote: "Changed", sparse: true } },
    { query: { operation: "void" }, body: identity },
  ])
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/refundreceipt/42/send")
    expect(url.searchParams.has("sendTo")).toBe(false)
    expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream")
    return Response.json({
      RefundReceipt: { ...identity, DeliveryInfo: { DeliveryType: "Email" } },
    })
  })
  expect((await qb.refundReceipts.send("42")).DeliveryInfo?.DeliveryType).toBe("Email")
})

test("receipt writes are never replayed after provider faults", async () => {
  const qb = await client()
  for (const run of [
    () => qb.salesReceipts.void(identity, { requestId: "key" }),
    () => qb.refundReceipts.void(identity, { requestId: "key" }),
    () => qb.salesReceipts.send("42", { requestId: "key" }),
  ]) {
    let calls = 0
    mock(() => {
      calls++
      return Response.json({ Fault: { Error: [{ code: "6540", Message: "Deposited" }] } })
    })
    const error = await run().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(QuickBooksApiError)
    expect(error).toHaveProperty("writeRequestId", "key")
    expect(calls).toBe(1)
  }
})

test("invalid receipt inputs reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(qb.salesReceipts.create({ ...receipt, Line: [] })).rejects.toThrow("Line")
  await expect(qb.salesReceipts.create({ ...receipt, CustomerRef: { value: "" } })).rejects.toThrow(
    "CustomerRef"
  )
  await expect(qb.salesReceipts.update({ ...identity, Line: [] })).rejects.toThrow("Line")
  await expect(
    qb.refundReceipts.create({
      ...refund,
      DepositToAccountRef: undefined,
    } as unknown as QuickBooksRefundReceiptCreate)
  ).rejects.toThrow("DepositToAccountRef")
  await expect(
    qb.refundReceipts.update({ ...identity, DepositToAccountRef: { value: "" } })
  ).rejects.toThrow("DepositToAccountRef")
  await expect(qb.refundReceipts.void({ Id: "42", SyncToken: "" })).rejects.toThrow("SyncToken")
  await expect(qb.salesReceipts.send("42", { sendTo: "" })).rejects.toThrow("sendTo")
  expect(calls).toBe(0)
})
