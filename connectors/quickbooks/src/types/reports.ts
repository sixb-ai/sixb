import type {
  REPORT_ACCOUNT_TYPES,
  REPORT_DATE_MACROS,
  REPORT_GROUP_BY,
  REPORT_PARAMETERS,
  REPORT_SUMMARIZE_BY,
  REPORTS,
} from "../report-catalog"

export type QuickBooksReportDateMacro = (typeof REPORT_DATE_MACROS)[number]
export type QuickBooksReportSummarizeColumnBy = (typeof REPORT_SUMMARIZE_BY)[number]
export type QuickBooksReportAccountType = (typeof REPORT_ACCOUNT_TYPES)[number]
export type QuickBooksReportGroupBy = (typeof REPORT_GROUP_BY)[number]

type OptionValue<Kind> = Kind extends "date" | "text"
  ? string
  : Kind extends "ids" | "keys"
    ? readonly string[]
    : Kind extends "boolean"
      ? boolean
      : Kind extends "amount" | "count" | "days"
        ? number
        : Kind extends readonly (infer Value)[]
          ? Value
          : never

/**
 * Every report option in camelCase. `REPORT_PARAMETERS` maps each to Intuit's parameter, e.g.
 * `startDate` to `start_date` and `customerIds` to a comma-separated `customer` list.
 */
export type QuickBooksReportOptions = {
  readonly [K in keyof typeof REPORT_PARAMETERS]?: OptionValue<(typeof REPORT_PARAMETERS)[K][1]>
}

export type QuickBooksReportMethod = keyof typeof REPORTS

type ReportEntries<M extends QuickBooksReportMethod> = (typeof REPORTS)[M][1][number]
type EntryKey<Entry> = Entry extends readonly [infer Key, unknown] ? Key : Entry
type EntryValue<Entry> = Entry extends readonly [unknown, infer Values extends readonly unknown[]]
  ? Values[number]
  : Entry extends keyof typeof REPORT_PARAMETERS
    ? OptionValue<(typeof REPORT_PARAMETERS)[Entry][1]>
    : never

/** The options one report method accepts, with any narrower per-report enumeration. */
export type QuickBooksReportOptionsFor<M extends QuickBooksReportMethod> = {
  readonly [Entry in ReportEntries<M> as EntryKey<Entry> & string]?: EntryValue<Entry>
}

export type QuickBooksReceivableAgingOptions = QuickBooksReportOptionsFor<"agedReceivables">
export type QuickBooksAgedReceivableDetailReportOptions =
  QuickBooksReportOptionsFor<"agedReceivableDetail">
export type QuickBooksPayableAgingOptions = QuickBooksReportOptionsFor<"agedPayables">
export type QuickBooksAgedPayableDetailReportOptions =
  QuickBooksReportOptionsFor<"agedPayableDetail">
/** Options shared by the aging summaries. */
export type QuickBooksAgingReportOptions = Pick<
  QuickBooksReportOptions,
  "reportDate" | "agingMethod" | "agingPeriod" | "numPeriods"
>
export type QuickBooksProfitAndLossReportOptions = QuickBooksReportOptionsFor<"profitAndLoss">
export type QuickBooksProfitAndLossDetailReportOptions =
  QuickBooksReportOptionsFor<"profitAndLossDetail">
export type QuickBooksBalanceSheetReportOptions = QuickBooksReportOptionsFor<"balanceSheet">
export type QuickBooksCashFlowReportOptions = QuickBooksReportOptionsFor<"cashFlow">
export type QuickBooksTrialBalanceReportOptions = QuickBooksReportOptionsFor<"trialBalance">
export type QuickBooksGeneralLedgerReportOptions = QuickBooksReportOptionsFor<"generalLedger">
export type QuickBooksTransactionListReportOptions = QuickBooksReportOptionsFor<"transactionList">
export type QuickBooksTransactionListByCustomerReportOptions =
  QuickBooksReportOptionsFor<"transactionListByCustomer">
export type QuickBooksTransactionListByVendorReportOptions =
  QuickBooksReportOptionsFor<"transactionListByVendor">
export type QuickBooksTransactionListWithSplitsReportOptions =
  QuickBooksReportOptionsFor<"transactionListWithSplits">
export type QuickBooksJournalReportOptions = QuickBooksReportOptionsFor<"journal">
export type QuickBooksCustomerBalanceReportOptions = QuickBooksReportOptionsFor<"customerBalance">
export type QuickBooksCustomerBalanceDetailReportOptions =
  QuickBooksReportOptionsFor<"customerBalanceDetail">
export type QuickBooksCustomerIncomeReportOptions = QuickBooksReportOptionsFor<"customerIncome">
export type QuickBooksCustomerSalesReportOptions = QuickBooksReportOptionsFor<"customerSales">
export type QuickBooksItemSalesReportOptions = QuickBooksReportOptionsFor<"itemSales">
export type QuickBooksVendorBalanceReportOptions = QuickBooksReportOptionsFor<"vendorBalance">
export type QuickBooksVendorBalanceDetailReportOptions =
  QuickBooksReportOptionsFor<"vendorBalanceDetail">
export type QuickBooksVendorExpensesReportOptions = QuickBooksReportOptionsFor<"vendorExpenses">
export type QuickBooksAccountListReportOptions = QuickBooksReportOptionsFor<"accountList">
export type QuickBooksClassSalesReportOptions = QuickBooksReportOptionsFor<"classSales">
export type QuickBooksDepartmentSalesReportOptions = QuickBooksReportOptionsFor<"departmentSales">
export type QuickBooksInventoryValuationSummaryReportOptions =
  QuickBooksReportOptionsFor<"inventoryValuationSummary">
export type QuickBooksInventoryValuationDetailReportOptions =
  QuickBooksReportOptionsFor<"inventoryValuationDetail">

export interface QuickBooksReportNameValue {
  readonly Name: string
  readonly Value: string
}

export interface QuickBooksReportColumn {
  readonly ColTitle?: string
  readonly ColType?: string
  readonly MetaData?: readonly QuickBooksReportNameValue[]
  readonly Columns?: { readonly Column: readonly QuickBooksReportColumn[] }
}

export interface QuickBooksReportCell {
  /** Provider text, including empty strings and decimal amounts; never coerced to a number. */
  readonly value: string
  readonly id?: string
  readonly href?: string
}

export interface QuickBooksReportRow {
  readonly type?: string
  readonly group?: string
  readonly Header?: { readonly ColData?: readonly QuickBooksReportCell[] }
  readonly ColData?: readonly QuickBooksReportCell[]
  readonly Rows?: { readonly Row?: readonly QuickBooksReportRow[] }
  readonly Summary?: { readonly ColData?: readonly QuickBooksReportCell[] }
}

/** Native report structure. Columns and row nesting depend on company settings and options. */
export interface QuickBooksReport {
  readonly Header: {
    readonly Time?: string
    readonly ReportName?: string
    readonly DateMacro?: string
    readonly ReportBasis?: string
    readonly StartPeriod?: string
    readonly EndPeriod?: string
    readonly SummarizeColumnsBy?: string
    readonly Currency?: string
    readonly Customer?: string
    readonly Vendor?: string
    readonly Employee?: string
    readonly Item?: string
    readonly Class?: string
    readonly Department?: string
    readonly Option?: readonly QuickBooksReportNameValue[]
  }
  readonly Columns: { readonly Column: readonly QuickBooksReportColumn[] }
  readonly Rows?: { readonly Row?: readonly QuickBooksReportRow[] }
}
