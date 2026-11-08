import { afterEach, expect, test } from "bun:test"
import {
  QuickBooksApiError,
  type QuickBooksEstimateListOptions,
  type QuickBooksEstimateUpdate,
  QuickBooksWriteError,
  quickbooks,
} from "../src"
import { estimate } from "./fixtures/transactions"

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
const identity = { Id: "42", SyncToken: "2" }
const line = {
  Amount: 300,
  DetailType: "SalesItemLineDetail" as const,
  SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 3, UnitPrice: 100 },
}
const create = { CustomerRef: { value: "9" }, Line: [line], ExpirationDate: "2026-10-01" }

test("estimate reads use the estimate envelope, customer filters and full provider lines", async () => {
  const qb = await client(false)
  mock((url) => {
    expect(url.pathname).toBe("/v3/company/123/estimate/42")
    expect(url.searchParams.get("minorversion")).toBe("75")
    return Response.json({ Estimate: estimate })
  })
  expect(await qb.estimates.get("42")).toEqual(estimate)
  const queries: string[] = []
  mock((url) => {
    const query = url.searchParams.get("query") ?? ""
    queries.push(query)
    return Response.json({
      QueryResponse: query.includes("STARTPOSITION 1 ")
        ? { Estimate: [estimate], startPosition: 1, maxResults: 1 }
        : {},
    })
  })
  const rows = []
  for await (const row of qb.estimates.listAll({
    customerIds: ["9"],
    docNumber: "EST-42",
    maxResults: 1,
  }))
    rows.push(row)
  expect(rows).toEqual([estimate])
  expect(queries).toEqual([
    "SELECT * FROM Estimate WHERE DocNumber = 'EST-42' AND CustomerRef IN ('9') ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 1",
    "SELECT * FROM Estimate WHERE DocNumber = 'EST-42' AND CustomerRef IN ('9') ORDERBY Id ASC STARTPOSITION 2 MAXRESULTS 1",
  ])
})

test("estimate status is not a query filter because QuickBooks rejects TxnStatus predicates", async () => {
  // Live sandbox at minor versions 75, 76 and 80: 4001 "property 'TxnStatus' is not queryable".
  let calls = 0
  mock(() => {
    calls++
    return Response.json({ QueryResponse: {} })
  })
  const qb = await client()
  for (const option of ["status", "TxnStatus", "vendorIds", "active"])
    await expect(
      qb.estimates.list({ [option]: "Pending" } as unknown as QuickBooksEstimateListOptions)
    ).rejects.toThrow(`Unsupported transaction list option: ${option}`)
  expect(calls).toBe(0)
})

test("estimate create, sparse acceptance update, line edit and delete keep provider contracts", async () => {
  const calls: { operation: string | null; requestId: string | null; body: unknown }[] = []
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/estimate")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("content-type")).toBe("application/json")
    calls.push({
      operation: url.searchParams.get("operation"),
      requestId: url.searchParams.get("requestid"),
      body: JSON.parse(String(init.body)),
    })
    return Response.json({
      Estimate:
        url.searchParams.get("operation") === "delete"
          ? { Id: "42", status: "Deleted" }
          : { ...estimate, SyncToken: "3" },
    })
  })
  const qb = await client()
  const options = { requestId: "estimate-key" }
  expect(await qb.estimates.create(create, options)).toHaveProperty("SyncToken", "3")
  const accept: QuickBooksEstimateUpdate = {
    ...identity,
    TxnStatus: "Accepted",
    AcceptedBy: "Example Customer",
    AcceptedDate: "2026-09-05",
  }
  await qb.estimates.update(accept, options)
  // Existing lines keep their IDs; a line without Id is new; omitted lines are removed.
  const lines = [
    { ...line, Id: "1", Amount: 400, SalesItemLineDetail: { ...line.SalesItemLineDetail, Qty: 4 } },
    { ...line, Amount: 25, SalesItemLineDetail: { ItemRef: { value: "5" }, Qty: 1 } },
  ]
  await qb.estimates.update({ ...identity, Line: lines }, options)
  await qb.estimates.update({ ...identity, TxnStatus: "Rejected" }, options)
  expect(await qb.estimates.delete({ ...identity }, options)).toEqual({
    Id: "42",
    status: "Deleted",
  })
  expect(calls).toEqual([
    { operation: null, requestId: "estimate-key", body: create },
    { operation: null, requestId: "estimate-key", body: { ...accept, sparse: true } },
    {
      operation: null,
      requestId: "estimate-key",
      body: { ...identity, Line: lines, sparse: true },
    },
    {
      operation: null,
      requestId: "estimate-key",
      body: { ...identity, TxnStatus: "Rejected", sparse: true },
    },
    { operation: "delete", requestId: "estimate-key", body: identity },
  ])
})

test("estimate send uses octet-stream with optional recipient and PDF preserves bytes", async () => {
  const qb = await client()
  for (const sendTo of [undefined, "estimates+test@example.com"]) {
    mock((url, init) => {
      expect(url.pathname).toBe("/v3/company/123/estimate/42/send")
      expect(url.searchParams.get("sendTo")).toBe(sendTo ?? null)
      expect(url.searchParams.get("requestid")).toBeTruthy()
      expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream")
      expect(init.body).toBe("")
      return Response.json({ Estimate: { ...estimate, EmailStatus: "EmailSent" } })
    })
    expect((await qb.estimates.send("42", { sendTo })).EmailStatus).toBe("EmailSent")
  }
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 0, 255])
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/estimate/42/pdf")
    expect(new Headers(init.headers).get("Accept")).toBe("application/pdf")
    return new Response(pdf, { headers: { "Content-Type": "application/pdf;charset=UTF-8" } })
  })
  expect(await qb.estimates.downloadPdf("42")).toEqual(pdf)
})

test("estimate writes are never replayed and failures keep the recovery key", async () => {
  const qb = await client()
  for (const kind of [200, 503, "network", "unusable"] as const) {
    let calls = 0
    mock(() => {
      calls++
      if (kind === "network") throw new Error("lost")
      if (kind === "unusable") return Response.json({ Estimate: { Id: "42" } })
      return Response.json(
        { Fault: { type: "ValidationFault", Error: [{ code: "6000", Message: "Invalid" }] } },
        { status: kind }
      )
    })
    const error = await qb.estimates
      .update({ ...identity, PrivateNote: "x" }, { requestId: "recover" })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(
      typeof kind === "number" ? QuickBooksApiError : QuickBooksWriteError
    )
    expect(error).toHaveProperty("writeRequestId", "recover")
    expect(calls).toBe(1)
  }
})

test("invalid estimate inputs reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(qb.estimates.create({ ...create, Line: [] })).rejects.toThrow("Line")
  await expect(qb.estimates.create({ ...create, CustomerRef: { value: "" } })).rejects.toThrow(
    "CustomerRef"
  )
  await expect(
    // @ts-expect-error Closed is set by QuickBooks; unknown statuses are rejected locally.
    qb.estimates.create({ ...create, TxnStatus: "Converted" })
  ).rejects.toThrow("TxnStatus")
  await expect(qb.estimates.create({ ...create, ...identity })).rejects.toThrow("Create input")
  await expect(qb.estimates.update({ ...identity, SyncToken: "" })).rejects.toThrow("SyncToken")
  await expect(qb.estimates.update({ ...identity, Line: [] })).rejects.toThrow("Line")
  await expect(qb.estimates.send("42", { sendTo: "" })).rejects.toThrow("sendTo")
  await expect(qb.estimates.delete(identity, { requestId: "x".repeat(51) })).rejects.toThrow("50")
  expect(() => qb.estimates.downloadPdf("..")).toThrow("entity ID")
  expect(calls).toBe(0)
})
