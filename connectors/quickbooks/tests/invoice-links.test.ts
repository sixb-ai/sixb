import { afterEach, expect, test } from "bun:test"
import { type QuickBooksInvoiceListOptions, quickbooks } from "../src"
import { invoice } from "./fixtures/transactions"

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
function mock(handler: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(new URL(String(input)), init ?? {}))) as typeof fetch
}
const link = "https://payments.example.test/invoice/opaque-token"

// Removal proof: restore an options parameter on invoices.get; `ids.map(qb.invoices.get)` then
// passes the array index as options and this call shape breaks.
test("invoice reads by ID keep the one-argument get used by callbacks", async () => {
  const qb = await client()
  const paths: string[] = []
  mock((url) => {
    paths.push(`${url.pathname}${url.searchParams.has("include") ? "?include" : ""}`)
    const id = url.pathname.split("/").at(-1) ?? ""
    return Response.json({ Invoice: { ...invoice, Id: id, InvoiceLink: link } })
  })
  const rows = await Promise.all(["41", "42"].map(qb.invoices.get))
  expect(rows.map((row) => row.InvoiceLink)).toEqual([link, link])
  expect(paths).toEqual(["/v3/company/123/invoice/41", "/v3/company/123/invoice/42"])
})

test("invoice queries pass include=invoiceLink beside the query on every page", async () => {
  const qb = await client()
  const seen: { include: string | null; query: string | null }[] = []
  mock((url) => {
    seen.push({ include: url.searchParams.get("include"), query: url.searchParams.get("query") })
    return Response.json({
      QueryResponse: url.searchParams.get("query")?.includes("STARTPOSITION 1 ")
        ? { Invoice: [{ ...invoice, InvoiceLink: link }], startPosition: 1, maxResults: 1 }
        : {},
    })
  })
  const rows = []
  for await (const row of qb.invoices.listAll({
    customerIds: ["9"],
    includeInvoiceLink: true,
    maxResults: 1,
  }))
    rows.push(row)
  expect(rows.map((row) => row.InvoiceLink)).toEqual([link])
  expect(seen).toEqual(
    [1, 2].map((start) => ({
      include: "invoiceLink",
      query: `SELECT * FROM Invoice WHERE CustomerRef IN ('9') ORDERBY Id ASC STARTPOSITION ${start} MAXRESULTS 1`,
    }))
  )
})

test("includeInvoiceLink is validated before any request", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(
    qb.invoices.list({ includeInvoiceLink: "yes" } as unknown as QuickBooksInvoiceListOptions)
  ).rejects.toThrow("includeInvoiceLink")
  expect(calls).toBe(0)
})

test("invoice creation can link an accepted estimate and a project", async () => {
  const qb = await client()
  const input = {
    CustomerRef: { value: "9" },
    ProjectRef: { value: "12" },
    LinkedTxn: [{ TxnId: "77", TxnType: "Estimate" }],
    Line: [
      {
        Amount: 300,
        DetailType: "SalesItemLineDetail" as const,
        SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 3, UnitPrice: 100 },
      },
    ],
  }
  const bodies: unknown[] = []
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/invoice")
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({ Invoice: { ...invoice, ...input, Id: "42", SyncToken: "0" } })
  })
  expect((await qb.invoices.create(input)).LinkedTxn).toEqual(input.LinkedTxn)
  await qb.invoices.update({ Id: "42", SyncToken: "0", LinkedTxn: [] })
  expect(bodies).toEqual([input, { Id: "42", SyncToken: "0", LinkedTxn: [], sparse: true }])
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  for (const LinkedTxn of [[{ TxnId: "", TxnType: "Estimate" }], [{ TxnId: "77", TxnType: "" }]])
    await expect(qb.invoices.create({ ...input, LinkedTxn })).rejects.toThrow("LinkedTxn")
  expect(calls).toBe(0)
})
