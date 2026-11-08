import { afterEach, expect, test } from "bun:test"
import {
  type QuickBooksDepositUpdate,
  type QuickBooksTimeActivityCreate,
  type QuickBooksTimeActivityListOptions,
  type QuickBooksTransferUpdate,
  QuickBooksWriteError,
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
const time = {
  NameOf: "Employee" as const,
  EmployeeRef: { value: "55" },
  CustomerRef: { value: "9" },
  ItemRef: { value: "3" },
  BillableStatus: "Billable" as const,
  HourlyRate: 50,
  Hours: 2,
  Minutes: 30,
  TxnDate: "2026-09-01",
}
const deposit = {
  DepositToAccountRef: { value: "35" },
  Line: [
    {
      Amount: 7,
      DetailType: "DepositLineDetail" as const,
      DepositLineDetail: { AccountRef: { value: "79" }, Entity: { value: "9", type: "Customer" } },
    },
    {
      Amount: -1,
      DetailType: "DepositLineDetail" as const,
      DepositLineDetail: { AccountRef: { value: "8" } },
    },
    { Amount: 5, LinkedTxn: [{ TxnId: "120", TxnType: "Payment", TxnLineId: "0" }] },
  ],
}
const transfer = { FromAccountRef: { value: "35" }, ToAccountRef: { value: "36" }, Amount: 2 }
const journal = {
  Line: [
    {
      Amount: 4,
      DetailType: "JournalEntryLineDetail" as const,
      JournalEntryLineDetail: {
        PostingType: "Debit" as const,
        AccountRef: { value: "7" },
        Entity: { Type: "Customer", EntityRef: { value: "9" } },
      },
    },
    {
      Amount: 4,
      DetailType: "JournalEntryLineDetail" as const,
      JournalEntryLineDetail: { PostingType: "Credit" as const, AccountRef: { value: "35" } },
    },
  ],
}

for (const [resource, entity, input, update] of [
  ["timeActivities", "TimeActivity", time, { ...identity, Hours: 3, Minutes: 0 }],
  ["deposits", "Deposit", deposit, { ...identity, DepositToAccountRef: { value: "35" } }],
  ["transfers", "Transfer", transfer, { ...identity, ...transfer, PrivateNote: "Moved" }],
  ["journalEntries", "JournalEntry", journal, { ...identity, PrivateNote: "Adjusted" }],
] as const) {
  test(`${resource}: create, sparse update and delete use the ${entity} envelope`, async () => {
    const calls: { operation: string | null; body: unknown }[] = []
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${entity.toLowerCase()}`)
      expect(url.searchParams.get("requestid")).toBe("key")
      calls.push({
        operation: url.searchParams.get("operation"),
        body: JSON.parse(String(init.body)),
      })
      return Response.json({
        [entity]:
          url.searchParams.get("operation") === "delete"
            ? { Id: "42", status: "Deleted" }
            : { ...identity, ...input },
      })
    })
    const qb = await client()
    const target = qb[resource] as unknown as {
      create(input: object, options: object): Promise<unknown>
      update(input: object, options: object): Promise<unknown>
      delete(input: object, options: object): Promise<unknown>
    }
    const options = { requestId: "key" }
    await target.create(input, options)
    await target.update(update, options)
    expect(await target.delete({ ...identity, ...input }, options)).toEqual({
      Id: "42",
      status: "Deleted",
    })
    expect(calls).toEqual([
      { operation: null, body: input },
      { operation: null, body: { ...update, sparse: true } },
      { operation: "delete", body: identity },
    ])
  })
}

test("transaction-like reads use each entity's verified predicates", async () => {
  const queries: string[] = []
  mock((url) => {
    queries.push(url.searchParams.get("query") ?? "")
    return Response.json({ QueryResponse: {} })
  })
  const qb = await client(false)
  await qb.timeActivities.list({ customerIds: ["9"], txnDateFrom: "2026-09-01" })
  await qb.deposits.list({ docNumber: "D-1" })
  await qb.transfers.list({ txnDateTo: "2026-09-30" })
  await qb.journalEntries.list({ orderBy: { field: "TxnDate", direction: "DESC" } })
  expect(queries).toEqual([
    "SELECT * FROM TimeActivity WHERE TxnDate >= '2026-09-01' AND CustomerRef IN ('9') ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
    "SELECT * FROM Deposit WHERE DocNumber = 'D-1' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
    "SELECT * FROM Transfer WHERE TxnDate <= '2026-09-30' ORDERBY Id ASC STARTPOSITION 1 MAXRESULTS 100",
    "SELECT * FROM JournalEntry ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100",
  ])
  // TimeActivity has no DocNumber; QuickBooks returns 4001 for it.
  await expect(
    qb.timeActivities.list({ docNumber: "1" } as unknown as QuickBooksTimeActivityListOptions)
  ).rejects.toThrow("Unsupported transaction list option: docNumber")
})

test("banking writes are never replayed when the response is lost", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    throw new Error("connection reset")
  })
  const error = await qb.journalEntries
    .create(journal, { requestId: "key" })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(QuickBooksWriteError)
  expect(error).toHaveProperty("writeRequestId", "key")
  expect(calls).toBe(1)
})

// Removal proof: drop the DepositToAccountRef/Transfer checks from update; the sparse cases
// then reach the network, where the live provider returned 2020 for each missing field.
test("invalid time, deposit, transfer and journal inputs reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  await expect(
    qb.timeActivities.create({
      ...time,
      NameOf: "Vendor",
    } as unknown as QuickBooksTimeActivityCreate)
  ).rejects.toThrow("NameOf")
  await expect(
    qb.timeActivities.create({ ...time, Hours: undefined, Minutes: undefined })
  ).rejects.toThrow("StartTime")
  await expect(qb.timeActivities.create({ ...time, Hours: 1.5 })).rejects.toThrow("Hours")
  // Removal proof: drop the NameOf check for updates in timeActivity; this reaches fetch.
  await expect(
    // @ts-expect-error A new worker reference needs NameOf.
    qb.timeActivities.update({ ...identity, EmployeeRef: { value: "56" } })
  ).rejects.toThrow("requires NameOf")
  await expect(
    // @ts-expect-error BillableStatus is one of the provider values.
    qb.timeActivities.update({ ...identity, BillableStatus: "Invoiced" })
  ).rejects.toThrow("BillableStatus")
  await expect(qb.deposits.create({ ...deposit, Line: [] })).rejects.toThrow("Line")
  await expect(
    qb.deposits.create({ ...deposit, Line: [{ Amount: 5, LinkedTxn: [] }] })
  ).rejects.toThrow("Deposit lines")
  await expect(
    qb.deposits.update({ ...identity, PrivateNote: "x" } as unknown as QuickBooksDepositUpdate)
  ).rejects.toThrow("DepositToAccountRef")
  await expect(
    qb.transfers.update({ ...identity, Amount: 2 } as unknown as QuickBooksTransferUpdate)
  ).rejects.toThrow("FromAccountRef")
  await expect(qb.transfers.create({ ...transfer, Amount: -2 })).rejects.toThrow("Amount")
  await expect(
    qb.journalEntries.create({
      Line: [
        {
          ...journal.Line[0],
          JournalEntryLineDetail: {
            ...journal.Line[0].JournalEntryLineDetail,
            PostingType: "Both" as "Debit",
          },
        },
      ],
    })
  ).rejects.toThrow("PostingType")
  await expect(
    qb.journalEntries.create({
      Line: [
        {
          ...journal.Line[1],
          JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "" } },
        },
      ],
    })
  ).rejects.toThrow("AccountRef")
  expect(calls).toBe(0)
})
