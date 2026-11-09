import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import {
  QuickBooksApiError,
  type QuickBooksCdcEntity,
  type QuickBooksClient,
  type QuickBooksRecurringTemplateType,
  type QuickBooksRevision,
  quickbooksEventsWebhook,
} from "../src"
import { connect, required } from "./live"

// Deliberately separate from normal unit tests and from each other: reads never imply writes.
const mode = process.env.QUICKBOOKS_LIVE
function sameIds(actual: readonly { Id: string }[], expected: readonly { Id: string }[]) {
  expect(new Set(actual.map((r) => r.Id)).size).toBe(actual.length)
  expect(actual.map((r) => r.Id).sort()).toEqual(expected.map((r) => r.Id).sort())
}
type Row = { Id: string } & Record<string, unknown>
type LooseResource = {
  get(id: string): Promise<Row>
  list(options: Record<string, unknown>): Promise<{ items: readonly Row[] }>
  listAll(options: Record<string, unknown>): AsyncIterable<Row>
}
type ReadCase =
  | {
      kind: "name"
      /** Row field holding the name; `queryName` is the query field when it differs. */
      name?: string
      queryName?: string
      active: boolean
    }
  | {
      kind: "transaction"
      party?: "CustomerRef" | "VendorRef"
      txnDate: boolean
      docNumber: boolean
      /** An extra exact-match filter and its field, e.g. payments' PaymentRefNum. */
      reference?: readonly [option: string, field: string]
    }

// Every paged list resource with the predicates QuickBooks accepted for it.
const readCases: Record<string, ReadCase> = {
  customers: { kind: "name", name: "DisplayName", active: true },
  vendors: { kind: "name", name: "DisplayName", active: true },
  employees: { kind: "name", name: "DisplayName", active: true },
  accounts: { kind: "name", name: "Name", active: true },
  items: { kind: "name", name: "Name", active: true },
  terms: { kind: "name", name: "Name", active: true },
  classes: { kind: "name", name: "Name", active: true },
  departments: { kind: "name", name: "Name", active: true },
  customerTypes: { kind: "name", name: "Name", active: true },
  paymentMethods: { kind: "name", name: "Name", active: true },
  taxCodes: { kind: "name", name: "Name", active: true },
  taxRates: { kind: "name", name: "Name", active: true },
  budgets: { kind: "name", name: "Name", active: true },
  taxAgencies: { kind: "name", name: "DisplayName", queryName: "Name", active: false },
  companyCurrencies: { kind: "name", active: true },
  invoices: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: true },
  payments: {
    kind: "transaction",
    party: "CustomerRef",
    txnDate: true,
    docNumber: false,
    reference: ["paymentRefNum", "PaymentRefNum"],
  },
  creditMemos: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: true },
  estimates: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: true },
  salesReceipts: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: true },
  refundReceipts: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: true },
  timeActivities: { kind: "transaction", party: "CustomerRef", txnDate: true, docNumber: false },
  reimburseCharges: { kind: "transaction", party: "CustomerRef", txnDate: false, docNumber: false },
  bills: { kind: "transaction", party: "VendorRef", txnDate: true, docNumber: true },
  billPayments: { kind: "transaction", party: "VendorRef", txnDate: true, docNumber: true },
  vendorCredits: { kind: "transaction", party: "VendorRef", txnDate: true, docNumber: true },
  purchaseOrders: { kind: "transaction", party: "VendorRef", txnDate: true, docNumber: true },
  purchases: { kind: "transaction", txnDate: true, docNumber: true },
  deposits: { kind: "transaction", txnDate: true, docNumber: true },
  transfers: { kind: "transaction", txnDate: true, docNumber: false },
  journalEntries: { kind: "transaction", txnDate: true, docNumber: true },
  creditCardPayments: { kind: "transaction", txnDate: true, docNumber: false },
  inventoryAdjustments: { kind: "transaction", txnDate: true, docNumber: true },
}

function updated(row: Row) {
  const value = (row.MetaData as { LastUpdatedTime?: string } | undefined)?.LastUpdatedTime
  return value ? Date.parse(value) : Number.NaN
}

test.skipIf(mode !== "read")(
  "sandbox read contracts and optional full enumeration",
  async () => {
    const { qb } = await connect()
    await qb.preferences.get()
    const full = process.env.QUICKBOOKS_EXHAUSTIVE === "1"
    for (const [name, config] of Object.entries(readCases)) {
      const resource = qb[name as keyof typeof qb] as unknown as LooseResource
      const isName = config.kind === "name"
      const options = isName && config.active ? { active: "all" as const } : {}
      const rows: Row[] = []
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
      // Send every supported predicate and sort once, even for empty datasets, so each one meets
      // a real provider envelope. Values match nothing, or only rows that satisfy them.
      const probes: Record<string, unknown>[] = [
        { ...options, ids: ["999999999"], maxResults: 2 },
        { ...options, updatedSince: new Date(), maxResults: 2 },
        { ...options, orderBy: { field: "Id", direction: "DESC" }, maxResults: 2 },
      ]
      if (config.kind === "name") {
        if (config.active) probes.push({ active: false, maxResults: 2 })
        if (config.name)
          probes.push(
            { ...options, name: "__sixb_none__", maxResults: 2 },
            {
              ...options,
              orderBy: { field: config.queryName ?? config.name, direction: "DESC" },
              maxResults: 2,
            }
          )
      } else {
        if (config.txnDate)
          probes.push({
            txnDateFrom: "2000-01-01",
            txnDateTo: "2000-01-02",
            orderBy: { field: "TxnDate", direction: "DESC" },
            maxResults: 2,
          })
        if (config.docNumber) probes.push({ docNumber: "__sixb_none__", maxResults: 2 })
        if (config.reference) probes.push({ [config.reference[0]]: "__sixb_none__", maxResults: 2 })
        if (config.party)
          probes.push({
            [config.party === "CustomerRef" ? "customerIds" : "vendorIds"]: ["999999999"],
            maxResults: 2,
          })
      }
      for (const probe of probes) {
        const page = await resource.list(probe)
        expect(page.items.length).toBeLessThanOrEqual(2)
        if (
          "ids" in probe ||
          "name" in probe ||
          "docNumber" in probe ||
          "customerIds" in probe ||
          "vendorIds" in probe
        )
          expect(page.items).toEqual([])
        if ("txnDateFrom" in probe) expect(page.items).toEqual([])
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
        // updatedSince never returns older rows and always returns strictly newer ones. Rows
        // displayed at exactly the bound second may be excluded: QuickBooks dropped two system
        // accounts there while including the oldest invoice.
        const stamps = [...new Set(rows.map(updated).filter(Number.isFinite))].sort((a, b) => a - b)
        for (const stamp of new Set([
          stamps[0],
          stamps[Math.floor(stamps.length / 2)],
          stamps.at(-1),
        ])) {
          if (stamp === undefined) continue
          const filtered: Row[] = []
          for await (const row of resource.listAll({
            ...options,
            updatedSince: new Date(stamp),
            maxResults: 7,
          }))
            filtered.push(row)
          const returned = new Set(filtered.map((r) => r.Id))
          expect(returned.size).toBe(filtered.length)
          expect(filtered.filter((r) => updated(r) < stamp)).toEqual([])
          expect(rows.filter((r) => updated(r) > stamp && !returned.has(r.Id))).toEqual([])
          const boundary = rows.filter((r) => updated(r) === stamp && !returned.has(r.Id))
          if (boundary.length)
            console.log(
              `[QuickBooksLive] ${name}: updatedSince excluded ${boundary.length} row(s) at the bound second`
            )
        }
        if (config.kind === "name") {
          if (config.active)
            for (const active of [true, false]) {
              const filtered = []
              for await (const row of resource.listAll({ active, maxResults: 7 }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter((r) => r.Active === active)
              )
            }
          const field = config.name
          if (field) {
            const names = new Set(rows.map((r) => r[field]))
            for (const value of names) {
              if (typeof value !== "string") throw new Error("[QuickBooksLive] Missing name field")
              const filtered = []
              for await (const row of resource.listAll({ ...options, name: value, maxResults: 7 }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter(
                  (r) =>
                    typeof r[field] === "string" &&
                    (r[field] as string).toLowerCase() === value.toLowerCase()
                )
              )
            }
          }
        } else {
          if (config.txnDate) {
            const dates = [
              ...new Set(rows.flatMap((r) => (typeof r.TxnDate === "string" ? [r.TxnDate] : []))),
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
          if (config.docNumber) {
            const numbers = [
              ...new Set(
                rows.flatMap((r) => (typeof r.DocNumber === "string" ? [r.DocNumber] : []))
              ),
            ].slice(0, 10)
            if (!numbers.length) console.log(`[QuickBooksLive] ${name}: docNumber unexercised`)
            for (const docNumber of numbers) {
              const filtered = []
              for await (const row of resource.listAll({ docNumber, maxResults: 7 }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter((r) => r.DocNumber === docNumber)
              )
            }
          }
          if (config.reference) {
            const [option, field] = config.reference
            const references = [
              ...new Set(rows.flatMap((r) => (typeof r[field] === "string" ? [r[field]] : []))),
            ].slice(0, 10)
            if (!references.length) console.log(`[QuickBooksLive] ${name}: ${option} unexercised`)
            for (const value of references) {
              const filtered = []
              for await (const row of resource.listAll({ [option]: value, maxResults: 7 }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter((r) => r[field] === value)
              )
            }
          }
          const partyField = config.party
          if (partyField) {
            const option = partyField === "CustomerRef" ? "customerIds" : "vendorIds"
            const party = (r: Row) => (r[partyField] as { value?: string } | undefined)?.value
            const parties = [...new Set(rows.map(party).filter((id) => id !== undefined))].slice(
              0,
              10
            )
            for (const ids of [...parties.map((id) => [id]), parties.slice(0, 3)]) {
              if (!ids.length) continue
              const filtered = []
              for await (const row of resource.listAll({ [option]: ids, maxResults: 7 }))
                filtered.push(row)
              sameIds(
                filtered,
                rows.filter((r) => ids.includes(party(r) as string))
              )
            }
          }
        }
      }
      console.log(
        `[QuickBooksLive] ${name}: ${rows.length} records checked (${full ? "complete" : "sample"})`
      )
    }
    // Every entity the connector accepts for CDC, checked against the public union so a new one
    // must be added here. Chunks keep each request well under the 1,000-object cap.
    const cdcEntities = Object.keys({
      Account: true,
      Attachable: true,
      Bill: true,
      BillPayment: true,
      Budget: true,
      Class: true,
      CompanyCurrency: true,
      CreditCardPaymentTxn: true,
      CreditMemo: true,
      Customer: true,
      CustomerType: true,
      Department: true,
      Deposit: true,
      Employee: true,
      Estimate: true,
      InventoryAdjustment: true,
      Invoice: true,
      Item: true,
      JournalEntry: true,
      Payment: true,
      PaymentMethod: true,
      Purchase: true,
      PurchaseOrder: true,
      RecurringTransaction: true,
      RefundReceipt: true,
      ReimburseCharge: true,
      SalesReceipt: true,
      TaxCode: true,
      TaxRate: true,
      Term: true,
      TimeActivity: true,
      Transfer: true,
      Vendor: true,
      VendorCredit: true,
    } satisfies Record<QuickBooksCdcEntity, true>) as QuickBooksCdcEntity[]
    for (let i = 0; i < cdcEntities.length; i += 9)
      await qb.cdc.get({
        entities: cdcEntities.slice(i, i + 9),
        changedSince: new Date(Date.now() - 86400_000),
      })
  },
  15 * 60_000
)

test.skipIf(mode !== "read")(
  "sandbox irregular reads: invoice links, tax classifications, exchange rates, recurring templates",
  async () => {
    const { qb } = await connect()
    const invoices = (await qb.invoices.list({ maxResults: 50, includeInvoiceLink: true })).items
    const eligible = invoices.filter((row) => row.BillEmail?.Address)
    for (const row of eligible.slice(0, 5)) expect(row.InvoiceLink).toMatch(/^https:\/\//)
    for (const row of invoices.filter((row) => !row.BillEmail?.Address))
      expect(row.InvoiceLink).toBeUndefined()

    const all = await qb.taxClassifications.list()
    expect(all.items.length).toBeGreaterThan(1000)
    const top = await qb.taxClassifications.list({ level: "1" })
    expect(top.items.every((row) => row.Level === "1")).toBe(true)
    const child = all.items.find((row) => row.ParentRef?.value)
    if (child?.ParentRef) {
      const siblings = await qb.taxClassifications.list({ parentId: child.ParentRef.value })
      expect(siblings.items.map((row) => row.Id)).toContain(child.Id)
      expect((await qb.taxClassifications.get(child.Id)).Id).toBe(child.Id)
      expect((await qb.taxClassifications.list({ ids: [child.Id] })).items).toHaveLength(1)
      if (child.Name)
        expect(
          (await qb.taxClassifications.list({ name: child.Name })).items.map((row) => row.Id)
        ).toContain(child.Id)
    }
    expect((await qb.taxClassifications.list({ name: "__sixb_none__" })).items).toEqual([])

    const rates = []
    for await (const rate of qb.exchangeRates.listAll({ maxResults: 50 })) {
      rates.push(rate)
      if (rates.length >= 150) break
    }
    expect(rates.every((rate) => typeof rate.SourceCurrencyCode === "string")).toBe(true)
    expect(
      (await qb.exchangeRates.list({ updatedSince: new Date(), maxResults: 5 })).items
    ).toEqual([])
    const today = new Date().toISOString().slice(0, 10)
    const eur = await qb.exchangeRates.get({ sourceCurrencyCode: "EUR" })
    expect(eur.SourceCurrencyCode).toBe("EUR")
    expect(
      (await qb.exchangeRates.get({ sourceCurrencyCode: "EUR", asOfDate: today })).AsOfDate
    ).toBe(today)

    const recurring = []
    for await (const row of qb.recurringTransactions.listAll({ maxResults: 1 })) recurring.push(row)
    for (const row of recurring) {
      const [type, template] = Object.entries(row)[0] as [
        QuickBooksRecurringTemplateType,
        { Id: string },
      ]
      expect(Object.keys(await qb.recurringTransactions.get(template.Id))).toEqual([type])
      const typed = await qb.recurringTransactions.list({ type, ids: [template.Id] })
      expect(typed.items).toHaveLength(1)
    }
    if (!recurring.length) console.log("[QuickBooksLive] recurringTransactions: empty")
    // Every PDF route, on the first existing record of each type (read-only).
    let pdfs = 0
    for (const name of [
      "invoices",
      "estimates",
      "salesReceipts",
      "refundReceipts",
      "creditMemos",
      "payments",
      "purchaseOrders",
    ] as const) {
      const resource = qb[name] as unknown as LooseResource & {
        downloadPdf(id: string): Promise<Uint8Array>
      }
      const [first] = (await resource.list({ maxResults: 1 })).items
      if (!first) {
        console.log(`[QuickBooksLive] ${name}: no record for PDF check`)
        continue
      }
      const pdf = await resource.downloadPdf(first.Id)
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
      pdfs++
    }
    expect((await qb.recurringTransactions.list({ updatedSince: new Date() })).items).toEqual([])
    const descending = await qb.recurringTransactions.list({
      orderBy: { field: "Id", direction: "DESC" },
    })
    expect(descending.items).toHaveLength(recurring.length)
    const other = await qb.recurringTransactions.list({ type: "JournalEntry" })
    expect(other.items.every((row) => "JournalEntry" in row)).toBe(true)
    console.log(
      `[QuickBooksLive] irregular reads: ${eligible.length} linked invoices, ${all.items.length} tax classifications, ${rates.length} exchange rates, ${recurring.length} recurring templates, ${pdfs} PDF routes`
    )
  },
  5 * 60_000
)

type Report = Awaited<ReturnType<QuickBooksClient["reports"]["profitAndLoss"]>>
type ReportRow = NonNullable<NonNullable<Report["Rows"]>["Row"]>[number]
function dataRows(rows: Report["Rows"]): ReportRow[] {
  return (rows?.Row ?? []).flatMap((row) => [...(row.ColData ? [row] : []), ...dataRows(row.Rows)])
}
function columnIndex(report: Report, key: string) {
  return report.Columns.Column.findIndex((column) =>
    column.MetaData?.some((entry) => entry.Name === "ColKey" && entry.Value === key)
  )
}
function option(report: Report, name: string) {
  return report.Header.Option?.find((entry) => entry.Name === name)?.Value
}

test.skipIf(mode !== "read")(
  "sandbox report contracts and parameter effects",
  async () => {
    const { qb } = await connect()
    const today = new Date().toISOString().slice(0, 10)
    const year = Number(today.slice(0, 4))
    const reports = qb.reports as unknown as Record<string, () => Promise<Report>>
    for (const method of Object.keys(qb.reports)) {
      const result = await reports[method]?.()
      expect(result?.Header).toBeDefined()
      expect(Array.isArray(result?.Columns.Column)).toBe(true)
      console.log(
        `[QuickBooksLive] report ${method}: ${result?.Header.ReportName} ${dataRows(result?.Rows).length} rows`
      )
    }

    const pnl = await qb.reports.profitAndLoss({
      startDate: `${year}-01-01`,
      endDate: `${year}-06-30`,
      accountingMethod: "Cash",
      summarizeColumnBy: "Month",
    })
    expect(pnl.Header.StartPeriod).toBe(`${year}-01-01`)
    expect(pnl.Header.EndPeriod).toBe(`${year}-06-30`)
    expect(pnl.Header.ReportBasis).toBe("Cash")
    expect(pnl.Header.SummarizeColumnsBy).toBe("Month")
    expect(pnl.Columns.Column.length).toBeGreaterThan(6)
    const balance = await qb.reports.balanceSheet({
      dateMacro: "Last Fiscal Year",
      accountingMethod: "Accrual",
    })
    expect(balance.Header.ReportBasis).toBe("Accrual")
    expect(balance.Header.EndPeriod?.startsWith(String(year - 1))).toBe(true)
    expect((await qb.reports.trialBalance({ endDate: today })).Header.EndPeriod).toBe(today)

    const customers = await qb.reports.customerBalance({ reportDate: today })
    expect(option(customers, "report_date")).toBe(today)
    const customerId = dataRows(customers.Rows).find((row) => row.ColData?.[0]?.id)?.ColData?.[0]
      ?.id
    if (customerId) {
      const one = await qb.reports.customerBalance({ reportDate: today, customerIds: [customerId] })
      const ids = dataRows(one.Rows).flatMap((row) =>
        row.ColData?.[0]?.id ? [row.ColData[0].id] : []
      )
      expect(new Set(ids)).toEqual(new Set([customerId]))
    }
    const vendors = await qb.reports.vendorBalance({ reportDate: today })
    const vendorId = dataRows(vendors.Rows).find((row) => row.ColData?.[0]?.id)?.ColData?.[0]?.id
    if (vendorId) {
      const one = await qb.reports.vendorBalance({ vendorIds: [vendorId] })
      const ids = dataRows(one.Rows).flatMap((row) =>
        row.ColData?.[0]?.id ? [row.ColData[0].id] : []
      )
      expect(new Set(ids)).toEqual(new Set([vendorId]))
    }

    const range = { startDate: `${year - 1}-01-01`, endDate: today }
    const narrow = await qb.reports.transactionList({
      ...range,
      columns: ["tx_date", "txn_type", "doc_num"],
    })
    expect(narrow.Columns.Column).toHaveLength(3)
    const invoices = await qb.reports.transactionList({ ...range, transactionType: "Invoice" })
    const typeColumn = columnIndex(invoices, "txn_type")
    const types = new Set(dataRows(invoices.Rows).map((row) => row.ColData?.[typeColumn]?.value))
    expect(types.size ? [...types] : ["Invoice"]).toEqual(["Invoice"])

    const banks = await qb.reports.accountList({ accountType: "Bank" })
    const accountTypeColumn = columnIndex(banks, "account_type")
    const bankRows = dataRows(banks.Rows)
    expect(bankRows.length).toBeGreaterThan(0)
    expect(new Set(bankRows.map((row) => row.ColData?.[accountTypeColumn]?.value))).toEqual(
      new Set(["Bank"])
    )
    const bankId = bankRows.find((row) => row.ColData?.[0]?.id)?.ColData?.[0]?.id
    if (bankId) {
      const ledger = await qb.reports.generalLedger({ ...range, accountIds: [bankId] })
      const sections = (ledger.Rows?.Row ?? []).filter((row) => row.Header?.ColData?.[0]?.id)
      expect(new Set(sections.map((row) => row.Header?.ColData?.[0]?.id))).toEqual(
        new Set([bankId])
      )
    }

    // Options added after Intuit's per-report reference was rechecked: each changes the output.
    const calendar = await qb.reports.profitAndLoss({
      dateMacro: "This Calendar Year",
      summarizeColumnBy: "FiscalQuarter",
    })
    expect([calendar.Header.StartPeriod, calendar.Header.EndPeriod]).toEqual([
      `${year}-01-01`,
      `${year}-12-31`,
    ])
    expect(calendar.Header.SummarizeColumnsBy).toBe("Quarter")
    const memos = await qb.reports.transactionList({ ...range, columns: ["tx_date", "memo"] })
    const memoColumn = columnIndex(memos, "memo")
    const memo = dataRows(memos.Rows).find((row) => row.ColData?.[memoColumn]?.value)?.ColData?.[
      memoColumn
    ]?.value
    if (memo) {
      const byMemo = await qb.reports.transactionList({
        ...range,
        memo,
        columns: ["tx_date", "memo"],
      })
      const values = dataRows(byMemo.Rows).map((row) => row.ColData?.[memoColumn]?.value)
      expect(values.length).toBeGreaterThan(0)
      expect(new Set(values)).toEqual(new Set([memo]))
    }
    const estimates = await qb.reports.transactionList({ ...range, transactionType: "Estimate" })
    const estimateColumn = columnIndex(estimates, "txn_type")
    const estimateTypes = dataRows(estimates.Rows).map(
      (row) => row.ColData?.[estimateColumn]?.value
    )
    expect(new Set(estimateTypes.length ? estimateTypes : ["Estimate"])).toEqual(
      new Set(["Estimate"])
    )
    const unfiltered = dataRows((await qb.reports.transactionList(range)).Rows).length
    const nonPosting = await qb.reports.transactionList({
      ...range,
      sourceAccountType: "NonPosting",
    })
    expect(dataRows(nonPosting.Rows).length).toBeLessThan(unfiltered)
    const createdToday = await qb.reports.transactionList({ ...range, createDateMacro: "Today" })
    expect(dataRows(createdToday.Rows).length).toBeLessThan(unfiltered)
    const bankLedger = await qb.reports.generalLedger({ ...range, accountType: "Bank" })
    const ledgerSections = (bankLedger.Rows?.Row ?? []).flatMap((row) =>
      row.Header?.ColData?.[0]?.value ? [row.Header.ColData[0].value] : []
    )
    const bankNames = bankRows.map((row) => row.ColData?.[0]?.value)
    expect(ledgerSections.length).toBeGreaterThan(0)
    for (const section of ledgerSections) expect(bankNames).toContain(section)

    for (const method of ["agedReceivables", "agedPayables"] as const) {
      const base = await qb.reports[method]({ reportDate: today })
      const lastYear = await qb.reports[method]({ dateMacro: "Last Calendar Year" })
      expect(lastYear.Header.EndPeriod).toBe(`${year - 1}-12-31`)
      const department = await qb.reports[method]({
        reportDate: today,
        departmentIds: ["999999999"],
      })
      expect(dataRows(department.Rows).length).toBeLessThan(dataRows(base.Rows).length)
      const periods = await qb.reports[method]({
        reportDate: today,
        agingPeriod: 15,
        numPeriods: 2,
      })
      expect(periods.Columns.Column.length).toBeLessThan(base.Columns.Column.length)
    }
    for (const zoom of [
      await qb.reports.agedReceivables({ reportDate: today, quickZoomUrl: true }),
      await qb.reports.profitAndLoss({ ...range, quickZoomUrl: true }),
      await qb.reports.balanceSheet({ quickZoomUrl: true }),
    ])
      expect(dataRows(zoom.Rows).some((row) => row.ColData?.some((cell) => cell.href))).toBe(true)
    const payablesUp = dataRows((await qb.reports.agedPayables({ sortOrder: "ascend" })).Rows)
    const payablesDown = dataRows((await qb.reports.agedPayables({ sortOrder: "descend" })).Rows)
    expect(payablesDown.length).toBe(payablesUp.length)
    if (payablesUp.length > 1)
      expect(payablesDown[0]?.ColData?.[0]?.value).not.toBe(payablesUp[0]?.ColData?.[0]?.value)
    for (const method of ["agedReceivableDetail", "agedPayableDetail"] as const) {
      const base = await qb.reports[method]({ reportDate: today })
      const narrowed = await qb.reports[method]({
        reportDate: today,
        columns: ["tx_date", "due_date", "past_due"],
        pastDue: 30,
      })
      expect(narrowed.Columns.Column).toHaveLength(3)
      const pastDue = columnIndex(narrowed, "past_due")
      for (const row of dataRows(narrowed.Rows))
        expect(Number(row.ColData?.[pastDue]?.value)).toBeGreaterThanOrEqual(30)
      const due = await qb.reports[method]({
        reportDate: today,
        startDueDate: `${year}-10-01`,
        endDueDate: `${year}-10-31`,
        columns: ["tx_date", "due_date"],
      })
      const dueColumn = columnIndex(due, "due_date")
      for (const row of dataRows(due.Rows)) {
        const value = row.ColData?.[dueColumn]?.value ?? ""
        expect(value >= `${year}-10-01` && value <= `${year}-10-31`).toBe(true)
      }
      const terms = await qb.reports[method]({ reportDate: today, termIds: ["999999999"] })
      expect(dataRows(terms.Rows).length).toBeLessThan(dataRows(base.Rows).length)
    }
    // Accepted but not positively verifiable here: QuickBooks validates these values (an invalid
    // accounting_method fails with 2170) yet the sandbox output does not change, so only
    // acceptance is asserted. agingMethod on AgedPayableDetail is kept for compatibility only.
    const payableDetail = dataRows((await qb.reports.agedPayableDetail({ reportDate: today })).Rows)
    for (const options of [
      { accountingMethod: "Cash" },
      { agingMethod: "Current" },
      { shipVia: "__sixb_none__" },
      { custom1: "__sixb_none__", custom2: "__sixb_none__", custom3: "__sixb_none__" },
    ] as const)
      expect(
        dataRows((await qb.reports.agedPayableDetail({ reportDate: today, ...options })).Rows)
      ).toHaveLength(payableDetail.length)

    // shipvia filters receivable detail reports: an unknown ship method leaves no rows.
    for (const method of ["agedReceivableDetail", "customerBalanceDetail"] as const) {
      const base = dataRows((await qb.reports[method]({ reportDate: today })).Rows)
      const none = dataRows(
        (await qb.reports[method]({ reportDate: today, shipVia: "__sixb_none__" })).Rows
      )
      expect(base.length).toBeGreaterThan(0)
      expect(none).toHaveLength(0)
      await qb.reports[method]({ reportDate: today, custom1: "__sixb_none__" })
    }
    await qb.reports.agedReceivableDetail({ custom2: "__sixb_none__", custom3: "__sixb_none__" })

    // QuickBooks resolves journal codes (unknown codes fail with 610); US companies have none.
    const journal = await qb.reports
      .journal({ ...range, journalCodes: ["__sixb_none__"] })
      .catch((error: unknown) => error)
    expect(journal).toBeInstanceOf(QuickBooksApiError)
    expect(journal).toHaveProperty("errors.0.code", "610")

    for (const groupBy of ["Name", "Account", "Transaction Type"] as const) {
      const splits = await qb.reports.transactionListWithSplits({ ...range, groupBy })
      expect((splits.Rows?.Row ?? []).some((row) => row.Header)).toBe(true)
    }

    const sectionsOf = (report: Report) =>
      (report.Rows?.Row ?? []).flatMap((row) => row.Header?.ColData?.[0]?.value ?? [])
    const inventory = { startDate: `${year}-01-01`, endDate: today }
    const byItem = await qb.reports.inventoryValuationDetail(inventory)
    const byType = await qb.reports.inventoryValuationDetail({
      ...inventory,
      groupBy: "Transaction Type",
    })
    expect(sectionsOf(byType)).not.toEqual(sectionsOf(byItem))
    const oldService = await qb.reports.inventoryValuationDetail({
      ...inventory,
      startServiceDate: "2000-01-01",
      endServiceDate: "2000-01-02",
    })
    expect(dataRows(byItem.Rows).length).toBeGreaterThan(0)
    expect(dataRows(oldService.Rows)).toHaveLength(0)
    const serviceMacro = await qb.reports.inventoryValuationDetail({
      ...inventory,
      serviceDateMacro: "This Calendar Year",
    })
    expect(dataRows(serviceMacro.Rows).length).toBeLessThanOrEqual(dataRows(byItem.Rows).length)

    const valuation = await qb.reports.inventoryValuationDetail({
      startDate: `${year}-01-01`,
      endDate: today,
      columns: ["tx_date", "txn_type", "quantity"],
    })
    expect([valuation.Header.StartPeriod, valuation.Header.EndPeriod]).toEqual([
      `${year}-01-01`,
      today,
    ])
    // The report always leads with a Product/Service grouping column that has no ColKey.
    expect(
      valuation.Columns.Column.filter((column) =>
        column.MetaData?.some((entry) => entry.Name === "ColKey")
      ).map((column) => column.MetaData?.find((entry) => entry.Name === "ColKey")?.Value)
    ).toEqual(["tx_date", "txn_type", "quantity"])

    const aging = await qb.reports.agedReceivables({
      reportDate: today,
      agingMethod: "Report_Date",
    })
    const shorter = await qb.reports.agedReceivables({
      reportDate: today,
      agingMethod: "Report_Date",
      agingPeriod: 15,
      numPeriods: 2,
    })
    expect(shorter.Columns.Column.length).toBeLessThan(aging.Columns.Column.length)
    expect(option(shorter, "report_date")).toBe(today)
  },
  10 * 60_000
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
