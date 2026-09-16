export interface QuickBooksPage<T> {
  readonly items: readonly T[]
  /** Provider metadata, absent when omitted by QuickBooks (including empty responses). */
  readonly startPosition?: number
  readonly maxResults?: number
  readonly totalCount?: number
  readonly time?: string
}

export interface QuickBooksPaginationOptions {
  /** One-based offset. Defaults to 1. */
  readonly startPosition?: number
  /** Page size, 1–1000. Defaults to 100. */
  readonly maxResults?: number
}

export interface QuickBooksListOptions<TName extends string = "Name">
  extends QuickBooksPaginationOptions {
  /** Defaults to active records. `all` explicitly includes inactive records. */
  readonly active?: boolean | "all"
  readonly ids?: readonly string[]
  /** Exact provider Name or DisplayName match. */
  readonly name?: string
  readonly orderBy?: { readonly field: "Id" | TName; readonly direction?: "ASC" | "DESC" }
}

export type QuickBooksCustomerListOptions = QuickBooksListOptions<"DisplayName">
export type QuickBooksVendorListOptions = QuickBooksListOptions<"DisplayName">
export type QuickBooksAccountListOptions = QuickBooksListOptions
export type QuickBooksItemListOptions = QuickBooksListOptions
export type QuickBooksTermListOptions = QuickBooksListOptions

/** Supported transaction query subset; dates are inclusive, calendar dates in YYYY-MM-DD form. */
export interface QuickBooksTransactionListOptions extends QuickBooksPaginationOptions {
  readonly ids?: readonly string[]
  readonly txnDateFrom?: string
  readonly txnDateTo?: string
  readonly orderBy?: { readonly field: "Id" | "TxnDate"; readonly direction?: "ASC" | "DESC" }
}

export type QuickBooksInvoiceListOptions = QuickBooksTransactionListOptions
export type QuickBooksPaymentListOptions = QuickBooksTransactionListOptions
export type QuickBooksCreditMemoListOptions = QuickBooksTransactionListOptions
export type QuickBooksBillListOptions = QuickBooksTransactionListOptions
export type QuickBooksBillPaymentListOptions = QuickBooksTransactionListOptions
export type QuickBooksVendorCreditListOptions = QuickBooksTransactionListOptions
