import { afterEach, expect, test } from "bun:test"
import {
  type QuickBooksAgingReportOptions,
  QuickBooksApiError,
  type QuickBooksClient,
  type QuickBooksPayableAgingOptions,
  type QuickBooksReceivableAgingOptions,
  quickbooks,
} from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
async function client(): Promise<QuickBooksClient> {
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
function mock(handler: (url: URL) => Response) {
  globalThis.fetch = ((input) => Promise.resolve(handler(new URL(String(input))))) as typeof fetch
}
// Synthetic report with summarized (nested) columns and string amounts.
const report = {
  Header: {
    ReportName: "ProfitAndLoss",
    ReportBasis: "Cash",
    StartPeriod: "2026-01-01",
    EndPeriod: "2026-06-30",
    SummarizeColumnsBy: "Month",
    Currency: "USD",
    Option: [{ Name: "NoReportData", Value: "false" }],
  },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      {
        ColTitle: "Jan 2026",
        ColType: "Money",
        MetaData: [{ Name: "StartDate", Value: "2026-01-01" }],
        Columns: { Column: [{ ColTitle: "Amount", ColType: "Money" }] },
      },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        group: "Income",
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: {
          Row: [
            { type: "Data", ColData: [{ value: "Landscaping", id: "45" }, { value: "1250.00" }] },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "1250.00" }] },
      },
    ],
  },
}

// Per-report options from Intuit's report reference, checked live (tests/README.md). The
// generator below drops a date macro when its explicit range is also listed.
const pl = ["startDate", "endDate", "dateMacro", "accountingMethod", "summarizeColumnBy"]
const dims = ["customerIds", "vendorIds", "itemIds", "classIds", "departmentIds"]
const detail = ["sortBy", "sortOrder", "columns"]
const txList = [
  "startDate",
  "endDate",
  "dateMacro",
  "departmentIds",
  "termIds",
  "nameIds",
  "paymentMethod",
  "memo",
  "transactionType",
  "docNumber",
  "startModDate",
  "endModDate",
  "modDateMacro",
  "createDateMacro",
  "startDueDate",
  "endDueDate",
  "dueDateMacro",
  "arPaid",
  "apPaid",
  "groupBy",
  "sourceAccountType",
  "printed",
  "bothAmount",
  "cleared",
  ...detail,
]
const agingSummary = ["reportDate", "dateMacro", "agingMethod", "agingPeriod", "numPeriods"]
const agingDetail = [
  "shipVia",
  "custom1",
  "custom2",
  "custom3",
  "reportDate",
  "agingPeriod",
  "numPeriods",
  "termIds",
  "startDueDate",
  "endDueDate",
  "pastDue",
  "columns",
]
const reports: Record<string, readonly [route: string, options: readonly string[]]> = {
  agedReceivables: [
    "AgedReceivables",
    [...agingSummary, "customerIds", "departmentIds", "sortOrder", "quickZoomUrl"],
  ],
  agedPayables: ["AgedPayables", [...agingSummary, "vendorIds", "departmentIds", "sortOrder"]],
  agedReceivableDetail: ["AgedReceivableDetail", [...agingDetail, "agingMethod", "customerIds"]],
  agedPayableDetail: [
    "AgedPayableDetail",
    [...agingDetail, "agingMethod", "accountingMethod", "vendorIds"],
  ],
  profitAndLoss: [
    "ProfitAndLoss",
    [...pl, ...dims, "sortOrder", "adjustedGainLoss", "quickZoomUrl"],
  ],
  balanceSheet: ["BalanceSheet", [...pl, ...dims, "sortOrder", "adjustedGainLoss", "quickZoomUrl"]],
  profitAndLossDetail: [
    "ProfitAndLossDetail",
    [
      "startDate",
      "endDate",
      "dateMacro",
      "accountingMethod",
      "customerIds",
      "vendorIds",
      "employeeIds",
      "classIds",
      "departmentIds",
      "accountIds",
      "accountType",
      "paymentMethod",
      "adjustedGainLoss",
      ...detail,
    ],
  ],
  cashFlow: [
    "CashFlow",
    ["startDate", "endDate", "dateMacro", "summarizeColumnBy", ...dims, "sortOrder"],
  ],
  trialBalance: ["TrialBalance", [...pl, "sortOrder"]],
  generalLedger: [
    "GeneralLedger",
    [
      ...pl,
      "accountIds",
      "sourceAccountIds",
      "accountType",
      "customerIds",
      "vendorIds",
      "classIds",
      "departmentIds",
      ...detail,
    ],
  ],
  transactionList: ["TransactionList", [...txList, "customerIds", "vendorIds"]],
  transactionListByCustomer: ["TransactionListByCustomer", [...txList, "customerIds"]],
  transactionListByVendor: ["TransactionListByVendor", [...txList, "vendorIds"]],
  transactionListWithSplits: [
    "TransactionListWithSplits",
    [
      "startDate",
      "endDate",
      "dateMacro",
      "nameIds",
      "paymentMethod",
      "transactionType",
      "docNumber",
      "groupBy",
      "sourceAccountType",
      ...detail,
    ],
  ],
  journal: ["JournalReport", ["startDate", "endDate", "dateMacro", "journalCodes", ...detail]],
  customerBalance: [
    "CustomerBalance",
    [
      "reportDate",
      "dateMacro",
      "accountingMethod",
      "arPaid",
      "customerIds",
      "departmentIds",
      "summarizeColumnBy",
      "sortOrder",
    ],
  ],
  customerBalanceDetail: [
    "CustomerBalanceDetail",
    [
      "reportDate",
      "customerIds",
      "departmentIds",
      "termIds",
      "startDueDate",
      "endDueDate",
      "arPaid",
      "agingMethod",
      "shipVia",
      "custom1",
      ...detail,
    ],
  ],
  customerIncome: [
    "CustomerIncome",
    [...pl, "customerIds", "termIds", "classIds", "departmentIds", "vendorIds", "sortOrder"],
  ],
  customerSales: [
    "CustomerSales",
    [...pl, "customerIds", "itemIds", "classIds", "departmentIds", "sortOrder"],
  ],
  itemSales: [
    "ItemSales",
    [
      ...pl,
      "customerIds",
      "itemIds",
      "classIds",
      "departmentIds",
      "sortOrder",
      "startDueDate",
      "endDueDate",
    ],
  ],
  vendorBalance: [
    "VendorBalance",
    [
      "reportDate",
      "dateMacro",
      "accountingMethod",
      "apPaid",
      "vendorIds",
      "departmentIds",
      "summarizeColumnBy",
      "sortOrder",
    ],
  ],
  vendorBalanceDetail: [
    "VendorBalanceDetail",
    [
      "reportDate",
      "dateMacro",
      "vendorIds",
      "departmentIds",
      "termIds",
      "startDueDate",
      "endDueDate",
      "dueDateMacro",
      "apPaid",
      "accountingMethod",
      ...detail,
    ],
  ],
  vendorExpenses: [
    "VendorExpenses",
    [...pl, "vendorIds", "customerIds", "classIds", "departmentIds", "sortOrder"],
  ],
  accountList: [
    "AccountList",
    [
      "startDate",
      "endDate",
      "startModDate",
      "endModDate",
      "modDateMacro",
      "createDateMacro",
      "accountType",
      "accountStatus",
      ...detail,
    ],
  ],
  classSales: ["ClassSales", [...pl, "classIds", "customerIds", "itemIds", "departmentIds"]],
  departmentSales: [
    "DepartmentSales",
    [...pl, "departmentIds", "customerIds", "itemIds", "classIds", "sortOrder"],
  ],
  inventoryValuationSummary: [
    "InventoryValuationSummary",
    ["reportDate", "dateMacro", "itemIds", "summarizeColumnBy", "sortOrder"],
  ],
  inventoryValuationDetail: [
    "InventoryValuationDetail",
    [
      "startDate",
      "endDate",
      "dateMacro",
      "startServiceDate",
      "endServiceDate",
      "serviceDateMacro",
      "groupBy",
      "columns",
    ],
  ],
}
const macroOf: Record<string, readonly [string, string]> = {
  dateMacro: ["startDate", "endDate"],
  dueDateMacro: ["startDueDate", "endDueDate"],
  modDateMacro: ["startModDate", "endModDate"],
  serviceDateMacro: ["startServiceDate", "endServiceDate"],
}
function explicitOptions(options: readonly string[]) {
  return options.filter((option) => !macroOf[option]?.some((bound) => options.includes(bound)))
}

// One valid value per option and the provider parameter it must become.
const values: Record<string, readonly [value: unknown, parameter: string, wire: string]> = {
  startDate: ["2026-01-01", "start_date", "2026-01-01"],
  endDate: ["2026-06-30", "end_date", "2026-06-30"],
  dateMacro: ["This Calendar Year", "date_macro", "This Calendar Year"],
  reportDate: ["2026-06-30", "report_date", "2026-06-30"],
  accountingMethod: ["Cash", "accounting_method", "Cash"],
  summarizeColumnBy: ["FiscalQuarter", "summarize_column_by", "FiscalQuarter"],
  sortOrder: ["descend", "sort_order", "descend"],
  sortBy: ["tx_date", "sort_by", "tx_date"],
  columns: [["tx_date", "doc_num"], "columns", "tx_date,doc_num"],
  customerIds: [["1", "2"], "customer", "1,2"],
  vendorIds: [["3"], "vendor", "3"],
  employeeIds: [["4"], "employee", "4"],
  nameIds: [["12", "13"], "name", "12,13"],
  itemIds: [["5"], "item", "5"],
  classIds: [["6"], "class", "6"],
  departmentIds: [["7"], "department", "7"],
  accountIds: [["8", "9"], "account", "8,9"],
  sourceAccountIds: [["10"], "source_account", "10"],
  termIds: [["11"], "term", "11"],
  accountType: ["Expense", "account_type", "Expense"],
  sourceAccountType: ["NonPosting", "source_account_type", "NonPosting"],
  accountStatus: ["Not_Deleted", "account_status", "Not_Deleted"],
  adjustedGainLoss: [true, "adjusted_gain_loss", "true"],
  quickZoomUrl: [false, "qzurl", "false"],
  agingMethod: ["Current", "aging_method", "Current"],
  agingPeriod: [15, "aging_period", "15"],
  numPeriods: [2, "num_periods", "2"],
  pastDue: [0, "past_due", "0"],
  arPaid: ["Unpaid", "arpaid", "Unpaid"],
  apPaid: ["Paid", "appaid", "Paid"],
  startDueDate: ["2026-07-01", "start_duedate", "2026-07-01"],
  endDueDate: ["2026-07-31", "end_duedate", "2026-07-31"],
  dueDateMacro: ["Next 4 Weeks", "duedate_macro", "Next 4 Weeks"],
  startModDate: ["2026-05-01", "start_moddate", "2026-05-01"],
  endModDate: ["2026-05-31", "end_moddate", "2026-05-31"],
  modDateMacro: ["Last Calendar Quarter", "moddate_macro", "Last Calendar Quarter"],
  createDateMacro: ["All", "createdate_macro", "All"],
  paymentMethod: ["Visa", "payment_method", "Visa"],
  transactionType: ["Invoice", "transaction_type", "Invoice"],
  docNumber: ["1001", "docnum", "1001"],
  memo: ["Opening Balance", "memo", "Opening Balance"],
  groupBy: ["Transaction Type", "group_by", "Transaction Type"],
  cleared: ["Reconciled", "cleared", "Reconciled"],
  printed: ["To_be_printed", "printed", "To_be_printed"],
  bothAmount: [12.5, "bothamount", "12.5"],
  startServiceDate: ["2026-02-01", "start_svcdate", "2026-02-01"],
  endServiceDate: ["2026-02-28", "end_svcdate", "2026-02-28"],
  serviceDateMacro: ["Last Month", "svcdate_macro", "Last Month"],
  shipVia: ["FedEx Ground", "shipvia", "FedEx Ground"],
  custom1: ["Crew A", "custom1", "Crew A"],
  custom2: ["Zone 2", "custom2", "Zone 2"],
  custom3: ["Spring", "custom3", "Spring"],
  journalCodes: [["AN", "BQ1"], "journal_code", "AN,BQ1"],
}

for (const [method, [route, options]] of Object.entries(reports)) {
  test(`${method}: serializes every documented option for /reports/${route}`, async () => {
    const qb = await client()
    const sent = explicitOptions(options)
    const input = Object.fromEntries(sent.map((option) => [option, values[option]?.[0]]))
    const expected = Object.fromEntries([
      ["minorversion", "75"],
      ...sent.map((option) => [values[option]?.[1], values[option]?.[2]]),
    ])
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/reports/${route}`)
      expect(Object.fromEntries(url.searchParams)).toEqual(expected)
      return Response.json(report)
    })
    const run = qb.reports[method as keyof QuickBooksClient["reports"]] as (
      options?: object
    ) => Promise<unknown>
    expect(await run(input)).toEqual(report)
    // Removal proof: drop the `allowed.includes` check in readReport; this then reaches fetch.
    await expect(run({ ...input, notAnOption: "x" })).rejects.toThrow(
      `Unsupported ${route} report option: notAnOption`
    )
    // Every listed macro is also accepted on its own.
    for (const macro of options.filter((option) => !sent.includes(option))) {
      mock((url) => {
        expect(url.searchParams.get(values[macro]?.[1] ?? "")).toBe(values[macro]?.[2] ?? null)
        return Response.json(report)
      })
      await run({ [macro]: values[macro]?.[0] })
    }
  })
}

test("report options outside a report's documented set reject before fetch", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json(report)
  })
  const qb = await client()
  const run = (method: string, options: object) =>
    (qb.reports[method as keyof QuickBooksClient["reports"]] as (o: object) => Promise<unknown>)(
      options
    )
  // Undocumented, or accepted by QuickBooks without any effect in the sandbox.
  for (const [method, option] of [
    ["trialBalance", "customerIds"],
    ["cashFlow", "accountingMethod"],
    ["classSales", "sortOrder"],
    ["classSales", "vendorIds"],
    ["departmentSales", "vendorIds"],
    ["transactionListByCustomer", "vendorIds"],
    ["transactionList", "startCreateDate"],
    ["journal", "accountIds"],
    ["agedReceivables", "vendorIds"],
    ["agedPayables", "customerIds"],
    ["agedPayables", "quickZoomUrl"],
    ["transactionList", "quickZoomUrl"],
    ["vendorBalance", "quickZoomUrl"],
    ["inventoryValuationSummary", "startDate"],
    ["inventoryValuationDetail", "itemIds"],
  ] as const)
    await expect(run(method, { [option]: values[option]?.[0] })).rejects.toThrow(
      `report option: ${option}`
    )
  expect(calls).toBe(0)
})

test("macros, ranges and option values are validated locally", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json(report)
  })
  const qb = await client()
  const invalid = [
    () => qb.reports.profitAndLoss({ startDate: "2026-02-30" }),
    () => qb.reports.profitAndLoss({ startDate: "2026-07-01", endDate: "2026-06-30" }),
    () => qb.reports.profitAndLoss({ dateMacro: "This Month", startDate: "2026-06-01" }),
    () => qb.reports.transactionList({ startDueDate: "2026-07-02", endDueDate: "2026-07-01" }),
    () => qb.reports.transactionList({ modDateMacro: "Today", endModDate: "2026-07-01" }),
    // @ts-expect-error Date macros are Intuit's fixed vocabulary.
    () => qb.reports.balanceSheet({ dateMacro: "Last 30 Days" }),
    // @ts-expect-error accounting_method is Cash or Accrual (QuickBooks: 2170 otherwise).
    () => qb.reports.trialBalance({ accountingMethod: "Modified" }),
    () => qb.reports.generalLedger({ accountIds: [] }),
    () => qb.reports.generalLedger({ columns: ["tx_date,doc_num"] }),
    () => qb.reports.transactionList({ docNumber: "" }),
    () => qb.reports.transactionList({ nameIds: ["1,2"] }),
    () => qb.reports.agedPayableDetail({ pastDue: -1 }),
    // @ts-expect-error Booleans are serialized by the connector.
    () => qb.reports.profitAndLoss({ adjustedGainLoss: "true" }),
    () => qb.reports.transactionList({ bothAmount: Number.NaN }),
    () => qb.reports.agedPayables({ agingPeriod: 0 }),
  ]
  for (const run of invalid) await expect(run()).rejects.toThrow("[SixbQuickBooks]")
  expect(calls).toBe(0)
  mock((url) => {
    expect(url.searchParams.get("date_macro")).toBe("Last Fiscal Year")
    expect(url.searchParams.has("start_date")).toBe(false)
    return Response.json(report)
  })
  await qb.reports.cashFlow({ dateMacro: "Last Fiscal Year" })
})

test("empty reports, HTTP-200 faults and malformed bodies are handled", async () => {
  const qb = await client()
  // Live sandbox: TransactionList with no data returned Rows: {} and NoReportData=true.
  const empty = {
    ...report,
    Header: { ...report.Header, Option: [{ Name: "NoReportData", Value: "true" }] },
    Rows: {},
  }
  mock(() => Response.json(empty))
  expect(await qb.reports.transactionList()).toEqual(empty)
  // Live sandbox: an invalid date produced HTTP 200 with a SystemFault body.
  mock(() =>
    Response.json(
      {
        Fault: {
          type: "SystemFault",
          Error: [{ code: "10000", Message: "An application error has occurred" }],
        },
      },
      { headers: { intuit_tid: "trace" } }
    )
  )
  const error = await qb.reports.profitAndLoss().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(QuickBooksApiError)
  expect(error).toMatchObject({ status: 200, faultType: "SystemFault", requestId: "trace" })
  for (const body of [
    { Header: {} },
    { ...report, Rows: { Row: [{ ColData: [{ value: 1 }] }] } },
  ]) {
    mock(() => Response.json(body))
    await expect(qb.reports.balanceSheet()).rejects.toThrow("[SixbQuickBooks]")
  }
})

test("group_by values are narrowed per report where Intuit documents fewer", async () => {
  // Live: TransactionListWithSplits rejected group_by=Customer (6000); Intuit documents only
  // Name, Account and Transaction Type there, and no fiscal groupings for InventoryValuationDetail.
  // Removal proof: replace the override entries in REPORTS with plain "groupBy"; both cases
  // below then reach fetch.
  let calls = 0
  mock(() => {
    calls++
    return Response.json(report)
  })
  const qb = await client()
  await expect(
    // @ts-expect-error Customer is not a TransactionListWithSplits grouping.
    qb.reports.transactionListWithSplits({ groupBy: "Customer" })
  ).rejects.toThrow("groupBy must be one of: Name, Account, Transaction Type")
  await expect(
    // @ts-expect-error Fiscal groupings are not documented for InventoryValuationDetail.
    qb.reports.inventoryValuationDetail({ groupBy: "Fiscal Year" })
  ).rejects.toThrow("groupBy must be one of")
  await expect(
    qb.reports.inventoryValuationDetail({
      serviceDateMacro: "Today",
      startServiceDate: "2026-01-01",
    })
  ).rejects.toThrow("Use serviceDateMacro or startServiceDate/endServiceDate, not both")
  expect(calls).toBe(0)
  await qb.reports.transactionList({ groupBy: "Fiscal Year" })
  expect(calls).toBe(1)
})

// The 0.2.0 aging option types, verbatim. Values they allowed must still compile and be sent.
interface ReleasedAgingOptions {
  readonly reportDate?: string
  readonly agingMethod?: "Current" | "Report_Date"
  readonly agingPeriod?: number
  readonly numPeriods?: number
}
interface ReleasedReceivableAgingOptions extends ReleasedAgingOptions {
  readonly customerIds?: readonly string[]
}
interface ReleasedPayableAgingOptions extends ReleasedAgingOptions {
  readonly vendorIds?: readonly string[]
}

// Removal proof: drop "agingMethod" from agedPayableDetail in REPORTS; the AgedPayableDetail calls
// here (and the unchanged 0.2.0 test in attachments-reports.test.ts) then throw.
test("aging methods accept every option their released 0.2.0 types allowed", async () => {
  const base = {
    reportDate: "2026-09-23",
    agingMethod: "Report_Date",
    agingPeriod: 30,
    numPeriods: 4,
  } as const
  const receivable: Required<ReleasedReceivableAgingOptions> = { ...base, customerIds: ["1"] }
  const payable: Required<ReleasedPayableAgingOptions> = { ...base, vendorIds: ["2"] }
  const shared: QuickBooksAgingReportOptions = base
  const receivableType: QuickBooksReceivableAgingOptions = receivable
  const payableType: QuickBooksPayableAgingOptions = payable
  const qb = await client()
  const sent: Record<string, string>[] = []
  mock((url) => {
    sent.push(Object.fromEntries(url.searchParams))
    return Response.json(report)
  })
  await qb.reports.agedReceivables(receivable)
  await qb.reports.agedReceivableDetail(receivable)
  await qb.reports.agedPayables(payable)
  await qb.reports.agedPayableDetail(payable)
  await qb.reports.agedPayableDetail(shared)
  const common = {
    report_date: "2026-09-23",
    aging_method: "Report_Date",
    aging_period: "30",
    num_periods: "4",
  }
  expect(sent.map(({ minorversion: _version, ...query }) => query)).toEqual([
    { ...common, customer: "1" },
    { ...common, customer: "1" },
    { ...common, vendor: "2" },
    { ...common, vendor: "2" },
    common,
  ])
  expect([receivableType.customerIds, payableType.vendorIds]).toEqual([["1"], ["2"]])
})
