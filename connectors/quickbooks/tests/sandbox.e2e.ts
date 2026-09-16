import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import {
  QuickBooksApiError,
  type QuickBooksRevision,
  quickbooks,
  quickbooksEventsWebhook,
} from "../src"

// Deliberately separate from normal unit tests and from each other: reads never imply writes.
const mode = process.env.QUICKBOOKS_LIVE
if (mode && !["read", "mutate", "webhook", "writes"].includes(mode)) {
  throw new Error("[QuickBooksLive] QUICKBOOKS_LIVE must be read, mutate, webhook, or writes.")
}
function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`[QuickBooksLive] Set ${name}. See tests/README.md.`)
  return value
}
async function connect() {
  const token = required("QUICKBOOKS_ACCESS_TOKEN")
  const realmId = required("QUICKBOOKS_REALM_ID")
  const adapter = quickbooks({
    clientId: required("CLIENT_ID"),
    clientSecret: required("CLIENT_SECRET"),
    environment: "sandbox",
    timeoutMs: 20_000,
    minDelayMs: 250,
  })
  const context = {
    projectId: "live-test",
    connectorId: "quickbooks",
    signal: AbortSignal.timeout(15 * 60_000),
  }
  const [account] = await adapter.discoverAccounts(context, {
    accessToken: token,
    authorizationContext: { realmId },
  })
  if (!account) throw new Error("[QuickBooksLive] No sandbox company discovered")
  return {
    realmId,
    token,
    qb: await adapter.connect({
      ...context,
      connectionId: "sandbox",
      account,
      tokenSource: {
        async get() {
          return { accessToken: token, invalidate() {} }
        },
      },
    }),
  }
}
function sameIds(actual: readonly { Id: string }[], expected: readonly { Id: string }[]) {
  expect(new Set(actual.map((r) => r.Id)).size).toBe(actual.length)
  expect(actual.map((r) => r.Id).sort()).toEqual(expected.map((r) => r.Id).sort())
}
test.skipIf(mode !== "read")(
  "sandbox read contracts and optional full enumeration",
  async () => {
    const { qb } = await connect()
    await qb.preferences.get()
    const full = process.env.QUICKBOOKS_EXHAUSTIVE === "1"
    for (const name of [
      "customers",
      "vendors",
      "accounts",
      "items",
      "terms",
      "invoices",
      "payments",
      "creditMemos",
      "bills",
      "billPayments",
      "vendorCredits",
    ] as const) {
      const resource = qb[name]
      const isName = ["customers", "vendors", "accounts", "items", "terms"].includes(name)
      const options = isName ? { active: "all" as const } : {}
      const rows = []
      for await (const row of resource.listAll({ ...options, maxResults: full ? 7 : 2 })) {
        rows.push(row)
        if (!full && rows.length === 5) break
        if (rows.length > 10_000)
          throw new Error("[QuickBooksLive] Import bound exceeded; completeness not verified")
      }
      sameIds(rows, rows)
      for (const row of rows) expect((await resource.get(row.Id)).Id).toBe(row.Id)
      if (!rows.length)
        console.log(
          `[QuickBooksLive] ${name}: empty; individual reads/positive filters unexercised`
        )
      for (let i = 0; i < rows.length; i += 25) {
        const selected = rows.slice(i, i + 25)
        const filtered = []
        for await (const row of resource.listAll({
          ...options,
          ids: selected.map((r) => r.Id),
          maxResults: 7,
        }))
          filtered.push(row)
        sameIds(filtered, selected)
      }
      if (full) {
        const manual = []
        for (let startPosition = 1; ; startPosition += 100) {
          const page = await resource.list({ ...options, startPosition, maxResults: 100 })
          manual.push(...page.items)
          if (manual.length > 10_000)
            throw new Error("[QuickBooksLive] Manual pagination bound exceeded")
          if (page.items.length < 100) break
        }
        sameIds(manual, rows)
        if (isName) {
          for (const active of [true, false]) {
            const filtered = []
            for await (const row of resource.listAll({ active, maxResults: 7 })) filtered.push(row)
            sameIds(
              filtered,
              rows.filter((r) => "Active" in r && r.Active === active)
            )
          }
          const names = new Set(
            rows.map((r) => ("DisplayName" in r ? r.DisplayName : "Name" in r ? r.Name : undefined))
          )
          for (const value of names) {
            if (typeof value !== "string") throw new Error("[QuickBooksLive] Missing name field")
            const filtered = []
            for await (const row of resource.listAll({ ...options, name: value, maxResults: 7 }))
              filtered.push(row)
            sameIds(
              filtered,
              rows.filter((r) => {
                const name = "DisplayName" in r ? r.DisplayName : "Name" in r ? r.Name : undefined
                return typeof name === "string" && name.toLowerCase() === value.toLowerCase()
              })
            )
          }
        } else {
          const dates = [
            ...new Set(
              rows.flatMap((r) =>
                "TxnDate" in r && typeof r.TxnDate === "string" ? [r.TxnDate] : []
              )
            ),
          ].sort()
          for (const date of new Set([
            dates[0],
            dates[Math.floor(dates.length / 2)],
            dates.at(-1),
          ])) {
            if (!date) continue
            for (const mode of ["from", "to", "exact"]) {
              const filtered = []
              for await (const row of resource.listAll({
                txnDateFrom: mode !== "to" ? date : undefined,
                txnDateTo: mode !== "from" ? date : undefined,
                maxResults: 7,
              }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter(
                  (r) =>
                    "TxnDate" in r &&
                    typeof r.TxnDate === "string" &&
                    (mode === "from"
                      ? r.TxnDate >= date
                      : mode === "to"
                        ? r.TxnDate <= date
                        : r.TxnDate === date)
                )
              )
            }
          }
        }
      }
      console.log(
        `[QuickBooksLive] ${name}: ${rows.length} records checked (${full ? "complete" : "sample"})`
      )
    }
    await qb.cdc.get({
      entities: ["Customer", "Invoice", "Bill", "VendorCredit"],
      changedSince: new Date(Date.now() - 86400_000),
    })
  },
  15 * 60_000
)

test.skipIf(mode !== "mutate")(
  "sandbox disposable customer and transaction lifecycles with cleanup journal",
  async () => {
    const { qb, token, realmId } = await connect()
    const journalPath = required("QUICKBOOKS_JOURNAL")
    const tag = `SixbTest-${crypto.randomUUID()}`
    // Exclusive creation prevents overwriting evidence from an interrupted run.
    const journal: {
      tag: string
      id?: string
      inactive?: boolean
      requestId?: string
      transactions: { entity: string; id: string; deleted: boolean }[]
    } = { tag, transactions: [] }
    await writeFile(journalPath, JSON.stringify(journal), { flag: "wx", mode: 0o600 })
    async function write(body: unknown, entity = "Customer", remove = false) {
      journal.requestId = crypto.randomUUID()
      await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
      const response = await fetch(
        `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/${entity.toLowerCase()}?minorversion=75&requestid=${journal.requestId}${remove ? "&operation=delete" : ""}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (!response.ok)
        throw new Error(
          `[QuickBooksLive] Customer write HTTP ${response.status}; request ${response.headers.get("intuit_tid")}. Inspect journal before retrying.`
        )
      const value = (await response.json()) as Record<string, { Id: string; SyncToken: string }>
      expect(typeof value[entity]?.Id).toBe("string")
      return value[entity]!
    }
    try {
      const created = await write({ DisplayName: tag })
      journal.id = created.Id
      await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
      expect((await qb.customers.get(created.Id)).DisplayName).toBe(tag)
      await write({
        Id: created.Id,
        SyncToken: created.SyncToken,
        sparse: true,
        DisplayName: `${tag}-updated`,
      })
      expect((await qb.customers.get(created.Id)).DisplayName).toBe(`${tag}-updated`)
      const vendor = (await qb.vendors.list({ maxResults: 1 })).items[0]
      const accounts = []
      for await (const account of qb.accounts.listAll()) accounts.push(account)
      const expense = accounts.find((a) => a.AccountType === "Expense")
      const items = []
      for await (const item of qb.items.listAll()) items.push(item)
      const item = items.find((i) => i.Type === "Service" && i.IncomeAccountRef)
      if (!vendor || !expense || !item)
        throw new Error("[QuickBooksLive] Sandbox needs a vendor, expense account and service item")
      for (const entity of ["Invoice", "Bill", "VendorCredit"] as const) {
        const since = new Date(Date.now() - 60_000)
        const body =
          entity === "Invoice"
            ? {
                CustomerRef: { value: created.Id },
                Line: [
                  {
                    Amount: 1.23,
                    DetailType: "SalesItemLineDetail",
                    SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 1.23 },
                  },
                ],
              }
            : {
                VendorRef: { value: vendor.Id },
                Line: [
                  {
                    Amount: 1.23,
                    DetailType: "AccountBasedExpenseLineDetail",
                    AccountBasedExpenseLineDetail: { AccountRef: { value: expense.Id } },
                  },
                ],
              }
        let row = await write({ ...body, PrivateNote: tag }, entity)
        const entry = { entity, id: row.Id, deleted: false }
        journal.transactions.push(entry)
        await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
        const reader =
          entity === "Invoice" ? qb.invoices : entity === "Bill" ? qb.bills : qb.vendorCredits
        async function changed(deleted: boolean) {
          for (let attempt = 0; attempt < 8; attempt++) {
            const result = await qb.cdc.get({ entities: [entity], changedSince: since })
            const found = result.CDCResponse.some((b) =>
              b.QueryResponse.some((g) =>
                (g[entity] ?? []).some(
                  (r) =>
                    r.Id === entry.id &&
                    (deleted
                      ? r.status === "Deleted"
                      : r.status !== "Deleted" && r.PrivateNote === `${tag}-updated`)
                )
              )
            )
            if (found) return
            if (attempt < 7) await Bun.sleep(3000)
          }
          throw new Error(`[QuickBooksLive] ${entity} CDC state not observed within bounded wait`)
        }
        try {
          expect((await reader.get(row.Id)).PrivateNote).toBe(tag)
          row = await write(
            {
              ...body,
              Id: row.Id,
              SyncToken: row.SyncToken,
              sparse: true,
              PrivateNote: `${tag}-updated`,
            },
            entity
          )
          expect((await reader.get(row.Id)).PrivateNote).toBe(`${tag}-updated`)
          await changed(false)
        } finally {
          // Read the latest revision so cleanup can follow a successful but response-lost update.
          const current = await reader.get(entry.id)
          await write({ Id: current.Id, SyncToken: current.SyncToken }, entity, true)
          entry.deleted = true
          await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
        }
        await changed(true)
        expect((await reader.list({ ids: [entry.id] })).items).toHaveLength(0)
      }
    } finally {
      if (journal.id) {
        const current = await qb.customers.get(journal.id)
        await write({ Id: current.Id, SyncToken: current.SyncToken, sparse: true, Active: false })
        expect((await qb.customers.get(current.Id)).Active).toBe(false)
        journal.inactive = true
        await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
      }
    }
  },
  5 * 60_000
)

test.skipIf(mode !== "webhook")(
  "captured provider payload verifies with the connector",
  async () => {
    // Capture files contain exact raw request bytes, not reserialized JSON. This is replay
    // verification, not a claim that a public endpoint or managed dispatch was exercised.
    const rawBody = new Uint8Array(await readFile(required("QUICKBOOKS_WEBHOOK_BODY")))
    const signature = (await readFile(required("QUICKBOOKS_WEBHOOK_SIGNATURE"), "utf8")).trim()
    const token = required("WEBHOOK_VERIFIER_TOKEN")
    expect(createHmac("sha256", token).update(rawBody).digest("base64")).toBe(signature)
    const hook = quickbooksEventsWebhook({ verifierToken: token, onEvent() {} })
    const context = {
      request: new Request("https://example.test/events", {
        headers: { "intuit-signature": signature },
      }),
      rawBody,
    }
    // Only these fields are read by the provider verifier. Framework context is tested in server tests.
    await hook.verify?.(context as Parameters<NonNullable<typeof hook.verify>>[0])
    expect(hook.body.parse(JSON.parse(new TextDecoder().decode(rawBody))).length).toBeGreaterThan(0)
  }
)

test.skipIf(mode !== "writes")(
  "public customer/vendor writes and invoice create/update/send/void/delete with cleanup",
  async () => {
    const { qb } = await connect()
    const journalPath = required("QUICKBOOKS_JOURNAL")
    // A reserved example domain tests Intuit's send response, not inbox delivery.
    const sendTo = process.env.QUICKBOOKS_SEND_TO ?? "sixb-invoice-test@example.com"
    const tag = `SixbWrite-${crypto.randomUUID()}`
    const journal: {
      tag: string
      operations: { operation: string; requestId: string; id?: string }[]
      customer?: string
      vendor?: string
      invoice?: string
      invoiceDeleted?: boolean
      customerInactive?: boolean
      vendorInactive?: boolean
    } = { tag, operations: [] }
    await writeFile(journalPath, JSON.stringify(journal), { flag: "wx", mode: 0o600 })
    const save = () => writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
    async function operation<T extends { Id: string }>(
      name: string,
      run: (options: { requestId: string }) => Promise<T>,
      requestId = crypto.randomUUID()
    ) {
      const entry = { operation: name, requestId, id: undefined as string | undefined }
      journal.operations.push(entry)
      await save()
      const result = await run({ requestId })
      entry.id = result.Id
      await save()
      return result
    }
    function revision(row: { Id: string; SyncToken?: string }): QuickBooksRevision {
      if (!row.SyncToken) throw new Error("[QuickBooksLive] Missing SyncToken")
      return { Id: row.Id, SyncToken: row.SyncToken }
    }
    const failures: unknown[] = []
    try {
      const createKey = crypto.randomUUID()
      const customer = await operation(
        "customer.create",
        (o) => qb.customers.create({ DisplayName: tag }, o),
        createKey
      )
      journal.customer = customer.Id
      await save()
      const replay = await operation(
        "customer.create replay",
        (o) => qb.customers.create({ DisplayName: tag }, o),
        createKey
      )
      expect(replay.Id).toBe(customer.Id)
      const updated = await operation("customer.update", (o) =>
        qb.customers.update({ ...revision(customer), CompanyName: "Sixb sandbox test" }, o)
      )
      expect((await qb.customers.get(customer.Id)).CompanyName).toBe("Sixb sandbox test")
      expect(updated.DisplayName).toBe(tag)
      const stale = await operation("customer.stale update", (o) =>
        qb.customers.update({ ...revision(customer), CompanyName: "Must not win" }, o)
      ).catch((error: unknown) => error)
      expect(stale).toBeInstanceOf(QuickBooksApiError)
      expect(stale).toHaveProperty("errors.0.code", "5010")
      const inactive = await operation("customer.deactivate", (o) =>
        qb.customers.deactivate(revision(updated), o)
      )
      expect(inactive.Active).toBe(false)
      expect(
        (
          await operation("customer.reactivate", (o) =>
            qb.customers.reactivate(revision(inactive), o)
          )
        ).Active
      ).toBe(true)

      let vendor = await operation("vendor.create", (o) =>
        qb.vendors.create({ DisplayName: `${tag}-vendor` }, o)
      )
      journal.vendor = vendor.Id
      await save()
      vendor = await operation("vendor.update", (o) =>
        qb.vendors.update({ ...revision(vendor), AcctNum: "sixb-test" }, o)
      )
      expect((await qb.vendors.get(vendor.Id)).AcctNum).toBe("sixb-test")
      vendor = await operation("vendor.deactivate", (o) =>
        qb.vendors.deactivate(revision(vendor), o)
      )
      expect(vendor.Active).toBe(false)
      vendor = await operation("vendor.reactivate", (o) =>
        qb.vendors.reactivate(revision(vendor), o)
      )
      expect(vendor.Active).toBe(true)

      const items = []
      for await (const item of qb.items.listAll()) items.push(item)
      const item = items.find((i) => i.Type === "Service" && i.IncomeAccountRef)
      if (!item) throw new Error("[QuickBooksLive] Sandbox needs a service item")
      let invoice = await operation("invoice.create", (o) =>
        qb.invoices.create(
          {
            CustomerRef: { value: customer.Id },
            PrivateNote: tag,
            Line: [
              {
                Amount: 1.23,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 1.23 },
              },
            ],
          },
          o
        )
      )
      journal.invoice = invoice.Id
      await save()
      expect((await qb.invoices.get(invoice.Id)).TotalAmt).toBe(1.23)
      invoice = await operation("invoice.update", (o) =>
        qb.invoices.update({ ...revision(invoice), PrivateNote: `${tag}-updated` }, o)
      )
      expect(invoice.PrivateNote).toBe(`${tag}-updated`)
      expect(invoice.TotalAmt).toBe(1.23)
      invoice = await operation("invoice.send explicit", (o) =>
        qb.invoices.send(invoice.Id, { ...o, sendTo })
      )
      expect(invoice.EmailStatus).toBe("EmailSent")
      expect(invoice.BillEmail?.Address).toBe(sendTo)
      expect(invoice.DeliveryInfo?.DeliveryTime).toBeTruthy()
      invoice = await operation("invoice.send BillEmail", (o) => qb.invoices.send(invoice.Id, o))
      expect(invoice.EmailStatus).toBe("EmailSent")
      invoice = await operation("invoice.void", (o) => qb.invoices.void(revision(invoice), o))
      expect(invoice.TotalAmt).toBe(0)
      expect((await qb.invoices.get(invoice.Id)).Balance).toBe(0)
    } catch (error) {
      failures.push(error)
    } finally {
      // Attempt every cleanup even if another cleanup fails. The journal retains recovery IDs.
      if (journal.invoice) {
        try {
          const row = await qb.invoices.get(journal.invoice)
          const deleted = await operation("invoice.delete", (o) =>
            qb.invoices.delete(revision(row), o)
          )
          expect(deleted.status).toBe("Deleted")
          journal.invoiceDeleted = true
          await save()
          expect((await qb.invoices.list({ ids: [row.Id] })).items).toHaveLength(0)
        } catch (error) {
          failures.push(error)
        }
      }
      for (const entity of ["customer", "vendor"] as const) {
        const id = journal[entity]
        if (!id) continue
        try {
          const resource = entity === "customer" ? qb.customers : qb.vendors
          const row = await resource.get(id)
          await operation(`${entity}.cleanup`, (o) => resource.deactivate(revision(row), o))
          expect((await resource.get(id)).Active).toBe(false)
          journal[entity === "customer" ? "customerInactive" : "vendorInactive"] = true
          await save()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "[QuickBooksLive] Write lifecycle failed; inspect cleanup journal"
      )
  },
  5 * 60_000
)
