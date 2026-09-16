import { afterEach, expect, test } from "bun:test"
import { QuickBooksApiError, QuickBooksWriteError, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function client(invalidate = () => {}) {
  return quickbooks({
    clientId: "client",
    clientSecret: "secret",
    environment: "sandbox",
    // A hostile custom policy must still never replay writes.
    retry: { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "c",
    signal: new AbortController().signal,
    account: { id: "123", label: "company" },
    tokenSource: {
      async get() {
        return { accessToken: "token", invalidate }
      },
    },
  })
}
function mock(fn: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(fn(new URL(String(input)), init ?? {}))) as typeof fetch
}
const identity = { Id: "42", SyncToken: "0" }
const invoice = {
  CustomerRef: { value: "7" },
  Line: [
    {
      Amount: 12.34,
      DetailType: "SalesItemLineDetail" as const,
      SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 2, UnitPrice: 6.17 },
    },
  ],
}

test("contact writes use company-scoped POST, explicit sparse revisions and minimal activation payloads", async () => {
  const qb = await client()
  for (const [name, entity] of [
    ["customers", "Customer"],
    ["vendors", "Vendor"],
  ] as const) {
    const bodies: unknown[] = []
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${entity.toLowerCase()}`)
      expect(url.searchParams.get("minorversion")).toBe("75")
      expect(url.searchParams.get("requestid")).toBe("persisted-key")
      expect(init.method).toBe("POST")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer token")
      expect(new Headers(init.headers).get("content-type")).toBe("application/json")
      bodies.push(JSON.parse(String(init.body)))
      return Response.json({
        [entity]: { ...identity, DisplayName: "Example", providerField: "retained" },
      })
    })
    const options = { requestId: "persisted-key" }
    const input = Object.freeze({ DisplayName: "Example", PrimaryPhone: { FreeFormNumber: "123" } })
    expect(await qb[name].create(input, options)).toHaveProperty("providerField", "retained")
    await qb[name].update({ ...identity, CompanyName: "Changed" }, options)
    await qb[name].deactivate({ ...identity, ...input }, options)
    await qb[name].reactivate(identity, options)
    expect(bodies).toEqual([
      input,
      { ...identity, CompanyName: "Changed", sparse: true },
      { ...identity, Active: false, sparse: true },
      { ...identity, Active: true, sparse: true },
    ])
    expect(input).not.toHaveProperty("sparse")
  }
})

test("invoice create, sparse update, void and delete preserve the provider operation contracts", async () => {
  const calls: { operation: string | null; body: unknown }[] = []
  const keys = new Set<string | null>()
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/invoice")
    expect(url.searchParams.get("minorversion")).toBe("75")
    keys.add(url.searchParams.get("requestid"))
    calls.push({
      operation: url.searchParams.get("operation"),
      body: JSON.parse(String(init.body)),
    })
    return Response.json({
      Invoice:
        url.searchParams.get("operation") === "delete"
          ? { Id: "42", status: "Deleted" }
          : { ...identity, ...invoice },
    })
  })
  const qb = await client()
  await qb.invoices.create(invoice)
  await qb.invoices.update({ ...identity, PrivateNote: "Changed" })
  await qb.invoices.void({ ...identity, ...invoice })
  expect(await qb.invoices.delete(identity)).toEqual({ Id: "42", status: "Deleted" })
  expect(calls).toEqual([
    { operation: null, body: invoice },
    { operation: null, body: { ...identity, PrivateNote: "Changed", sparse: true } },
    { operation: "void", body: identity },
    { operation: "delete", body: identity },
  ])
  expect(keys.size).toBe(4)
  expect(keys.has(null)).toBe(false)
})

test("sending uses octet-stream and an encoded optional recipient, not a JSON entity update", async () => {
  const qb = await client()
  for (const sendTo of [undefined, "billing+test@example.com"]) {
    mock((url, init) => {
      expect(url.pathname).toBe("/v3/company/123/invoice/42/send")
      expect(url.searchParams.get("sendTo")).toBe(sendTo ?? null)
      expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream")
      expect(init.body).toBe("")
      return Response.json({ Invoice: { ...identity, EmailStatus: "EmailSent" } })
    })
    expect((await qb.invoices.send("42", { sendTo })).EmailStatus).toBe("EmailSent")
  }
})

test("writes never replay HTTP failures or lost responses, including sends and 401 refresh", async () => {
  // Regression proof: remove { retryable: false } in http.ts. This test then observes
  // three POSTs under the custom retry policy (and a 401 credential invalidation).
  let invalidations = 0
  const qb = await client(() => {
    invalidations++
  })
  for (const status of [400, 401, 429, 503, "network"] as const) {
    for (const send of [false, true]) {
      let calls = 0
      mock(() => {
        calls++
        if (status === "network") throw new Error("response lost")
        return Response.json(
          {
            Fault: {
              type: "ValidationFault",
              Error: [{ code: "5010", Message: "Stale Object Error" }],
            },
          },
          { status, headers: { intuit_tid: "trace-id" } }
        )
      })
      const pending = send
        ? qb.invoices.send("42", { requestId: "recoverable" })
        : qb.customers.create({ DisplayName: "Example" }, { requestId: "recoverable" })
      const error = await pending.catch((error: unknown) => error)
      expect(error).toBeInstanceOf(status === "network" ? QuickBooksWriteError : QuickBooksApiError)
      expect(error).toHaveProperty("writeRequestId", "recoverable")
      if (status !== "network") {
        expect(error).toHaveProperty("requestId", "trace-id")
        expect(error).toHaveProperty("errors.0.code", "5010")
      }
      expect(calls).toBe(1)
    }
  }
  expect(invalidations).toBe(0)
})

test("unusable successful write responses carry the recovery key", async () => {
  const qb = await client()
  for (const body of [
    {},
    { Invoice: { Id: "wrong", SyncToken: "1" } },
    { Invoice: { Id: "42" } },
    "not-json",
  ]) {
    mock(() => (typeof body === "string" ? new Response(body) : Response.json(body)))
    const error = await qb.invoices
      .update({ ...identity, PrivateNote: "x" }, { requestId: "key" })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(QuickBooksWriteError)
    expect(error).toHaveProperty("writeRequestId", "key")
  }
  mock(() => Response.json({ Invoice: identity }))
  await expect(qb.invoices.delete(identity)).rejects.toBeInstanceOf(QuickBooksWriteError)
})

test("invalid identities, creation payloads and operation options fail before sending", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(qb.customers.create({ DisplayName: " " })).rejects.toThrow("DisplayName")
  await expect(qb.vendors.create({ DisplayName: "x", ...identity })).rejects.toThrow("Create input")
  await expect(qb.customers.update({ Id: "42", SyncToken: "" })).rejects.toThrow("SyncToken")
  await expect(qb.vendors.update({ Id: "", SyncToken: "0" })).rejects.toThrow("Id")
  await expect(qb.invoices.create({ ...invoice, Line: [] })).rejects.toThrow("Line")
  await expect(qb.invoices.create({ ...invoice, CustomerRef: { value: "" } })).rejects.toThrow(
    "CustomerRef"
  )
  await expect(
    qb.invoices.create({ ...invoice, Line: [{ ...invoice.Line[0]!, Amount: NaN }] })
  ).rejects.toThrow("finite")
  await expect(qb.invoices.send("42", { sendTo: "" })).rejects.toThrow("sendTo")
  await expect(qb.invoices.create({ ...invoice, ExchangeRate: Infinity })).rejects.toThrow("finite")
  await expect(qb.customers.deactivate({ Id: "42", SyncToken: "" })).rejects.toThrow("SyncToken")
  await expect(qb.invoices.send("..", {})).rejects.toThrow("entity ID")
  await expect(qb.invoices.void(identity, { requestId: "" })).rejects.toThrow("requestId")
  await expect(qb.invoices.delete(identity, { requestId: "x".repeat(51) })).rejects.toThrow("50")
  expect(calls).toBe(0)
})
