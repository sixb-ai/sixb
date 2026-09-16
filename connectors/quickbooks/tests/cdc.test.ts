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
    { ...options, entities: ["TaxCode"] },
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
