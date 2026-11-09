import { afterEach, expect, test } from "bun:test"
import {
  QuickBooksApiError,
  type QuickBooksPurchaseListOptions,
  type QuickBooksPurchaseUpdate,
  quickbooks,
} from "../src"

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
    Amount: 3.5,
    DetailType: "AccountBasedExpenseLineDetail" as const,
    AccountBasedExpenseLineDetail: { AccountRef: { value: "7" }, CustomerRef: { value: "9" } },
  },
  {
    Amount: 6,
    DetailType: "ItemBasedExpenseLineDetail" as const,
    ItemBasedExpenseLineDetail: { ItemRef: { value: "3" }, Qty: 2, UnitPrice: 3 },
  },
]
const purchase = {
  PaymentType: "CreditCard" as const,
  AccountRef: { value: "41" },
  EntityRef: { value: "17", type: "Vendor" },
  Credit: false,
  Line,
}
const order = { VendorRef: { value: "17" }, POEmail: { Address: "po@example.com" }, Line }

test("purchases: reads have no party filter because EntityRef is not queryable", async () => {
  // Live sandbox: VendorRef "not found" and EntityRef "not queryable" (4001) for Purchase.
  const qb = await client(false)
  mock((url) => {
    if (url.pathname.endsWith("/purchase/42"))
      return Response.json({ Purchase: { ...identity, ...purchase } })
    expect(url.searchParams.get("query")).toBe(
      "SELECT * FROM Purchase WHERE DocNumber = 'CHK-1' ORDERBY TxnDate ASC STARTPOSITION 1 MAXRESULTS 100"
    )
    return Response.json({ QueryResponse: {} })
  })
  expect(await qb.purchases.get("42")).toEqual({ ...identity, ...purchase })
  await qb.purchases.list({ docNumber: "CHK-1", orderBy: { field: "TxnDate" } })
  for (const option of ["vendorIds", "customerIds"])
    await expect(
      qb.purchases.list({ [option]: ["17"] } as unknown as QuickBooksPurchaseListOptions)
    ).rejects.toThrow(`Unsupported transaction list option: ${option}`)
})

test("purchase writes keep the payment discriminator on sparse updates", async () => {
  const calls: { operation: string | null; body: unknown }[] = []
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/purchase")
    calls.push({
      operation: url.searchParams.get("operation"),
      body: JSON.parse(String(init.body)),
    })
    return Response.json({
      Purchase:
        url.searchParams.get("operation") === "delete"
          ? { Id: "42", status: "Deleted" }
          : { ...identity, ...purchase },
    })
  })
  const qb = await client()
  await qb.purchases.create(purchase)
  await qb.purchases.update({ ...identity, PaymentType: "CreditCard", PrivateNote: "Fuel" })
  expect(await qb.purchases.delete(identity)).toEqual({ Id: "42", status: "Deleted" })
  expect(calls).toEqual([
    { operation: null, body: purchase },
    {
      operation: null,
      body: { ...identity, PaymentType: "CreditCard", PrivateNote: "Fuel", sparse: true },
    },
    { operation: "delete", body: identity },
  ])
})

test("purchase orders: vendor filter, writes, send and PDF", async () => {
  const qb = await client()
  const calls: { path: string; operation: string | null; body: unknown }[] = []
  mock((url, init) => {
    if (url.pathname.endsWith("/pdf"))
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "Content-Type": "application/pdf" },
      })
    calls.push({
      path: url.pathname.replace("/v3/company/123/", ""),
      operation: url.searchParams.get("operation") ?? url.searchParams.get("sendTo"),
      body: init.body === "" || init.body === undefined ? null : JSON.parse(String(init.body)),
    })
    if (url.pathname.endsWith("/query")) return Response.json({ QueryResponse: {} })
    return Response.json({
      PurchaseOrder:
        url.searchParams.get("operation") === "delete"
          ? { Id: "42", status: "Deleted" }
          : { ...identity, ...order, EmailStatus: "EmailSent" },
    })
  })
  await qb.purchaseOrders.create(order)
  await qb.purchaseOrders.update({ ...identity, POStatus: "Closed", Memo: "Received" })
  await qb.purchaseOrders.send("42", { sendTo: "po@example.com" })
  await qb.purchaseOrders.delete(identity)
  expect(await qb.purchaseOrders.downloadPdf("42")).toEqual(new Uint8Array([37, 80, 68, 70]))
  expect(calls).toEqual([
    { path: "purchaseorder", operation: null, body: order },
    {
      path: "purchaseorder",
      operation: null,
      body: { ...identity, POStatus: "Closed", Memo: "Received", sparse: true },
    },
    { path: "purchaseorder/42/send", operation: "po@example.com", body: null },
    { path: "purchaseorder", operation: "delete", body: identity },
  ])
  const query = await (async () => {
    let captured = ""
    mock((url) => {
      captured = url.searchParams.get("query") ?? ""
      return Response.json({ QueryResponse: {} })
    })
    await (await client(false)).purchaseOrders.list({ vendorIds: ["17"], txnDateTo: "2026-09-30" })
    return captured
  })()
  expect(query).toBe(
    "SELECT * FROM PurchaseOrder WHERE TxnDate <= '2026-09-30' AND VendorRef IN ('17') ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100"
  )
})

test("purchase writes are not replayed after a fault", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    return Response.json(
      { Fault: { Error: [{ code: "2020", Message: "Required param missing" }] } },
      { status: 400 }
    )
  })
  const error = await qb.purchases
    .update({ ...identity, PaymentType: "Cash" }, { requestId: "key" })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(QuickBooksApiError)
  expect(error).toHaveProperty("writeRequestId", "key")
  expect(calls).toBe(1)
})

// Removal proof: drop nonEmpty(input.PaymentType) from purchases.update; the first sparse
// case reaches the network, where the live provider returned 2020 "PaymentType is missing".
test("invalid purchase and purchase order inputs reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(
    qb.purchases.update({ ...identity, PrivateNote: "x" } as unknown as QuickBooksPurchaseUpdate)
  ).rejects.toThrow("PaymentType")
  await expect(
    // @ts-expect-error Purchases are Cash, Check or CreditCard.
    qb.purchases.create({ ...purchase, PaymentType: "Wire" })
  ).rejects.toThrow("PaymentType")
  await expect(qb.purchases.create({ ...purchase, AccountRef: { value: "" } })).rejects.toThrow(
    "AccountRef"
  )
  await expect(qb.purchases.create({ ...purchase, Line: [] })).rejects.toThrow("Line")
  await expect(qb.purchaseOrders.create({ ...order, VendorRef: { value: "" } })).rejects.toThrow(
    "VendorRef"
  )
  await expect(
    // @ts-expect-error POStatus is Open or Closed.
    qb.purchaseOrders.update({ ...identity, POStatus: "Received" })
  ).rejects.toThrow("POStatus")
  await expect(qb.purchaseOrders.send("42", { sendTo: "" })).rejects.toThrow("sendTo")
  expect(calls).toBe(0)
})
