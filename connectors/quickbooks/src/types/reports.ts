export interface QuickBooksAgingReportOptions {
  /** Calendar date YYYY-MM-DD. Omitted options use QuickBooks defaults. */
  readonly reportDate?: string
  readonly agingMethod?: "Current" | "Report_Date"
  readonly agingPeriod?: number
  readonly numPeriods?: number
}

export interface QuickBooksReceivableAgingOptions extends QuickBooksAgingReportOptions {
  readonly customerIds?: readonly string[]
}

export interface QuickBooksPayableAgingOptions extends QuickBooksAgingReportOptions {
  readonly vendorIds?: readonly string[]
}

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
    readonly ReportBasis?: string
    readonly StartPeriod?: string
    readonly EndPeriod?: string
    readonly Currency?: string
    readonly SummarizeColumnsBy?: string
    readonly Option?: readonly QuickBooksReportNameValue[]
  }
  readonly Columns: { readonly Column: readonly QuickBooksReportColumn[] }
  readonly Rows?: { readonly Row?: readonly QuickBooksReportRow[] }
}
