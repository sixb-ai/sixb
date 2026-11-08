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

/** Sort direction for query `ORDERBY`. */
export type QuickBooksSortDirection = "ASC" | "DESC"

/** The provider modification timestamp, sortable on every queryable entity except TaxClassification. */
export type QuickBooksUpdatedField = "MetaData.LastUpdatedTime"

/** Name-list query subset without an Active predicate or name field. */
export interface QuickBooksReferenceListOptions<TSort extends string = "Id">
  extends QuickBooksPaginationOptions {
  readonly ids?: readonly string[]
  /** `MetaData.LastUpdatedTime >=` bound; rows at exactly the bound second can be omitted. */
  readonly updatedSince?: Date
  readonly orderBy?: {
    readonly field: "Id" | QuickBooksUpdatedField | TSort
    readonly direction?: QuickBooksSortDirection
  }
}

export interface QuickBooksListOptions<TName extends string = "Name">
  extends QuickBooksReferenceListOptions<TName> {
  /** Defaults to active records. `all` explicitly includes inactive records. */
  readonly active?: boolean | "all"
  /** Exact provider Name or DisplayName match. */
  readonly name?: string
}

export type QuickBooksCustomerListOptions = QuickBooksListOptions<"DisplayName">
export type QuickBooksVendorListOptions = QuickBooksListOptions<"DisplayName">
export type QuickBooksEmployeeListOptions = QuickBooksListOptions<"DisplayName">
export type QuickBooksAccountListOptions = QuickBooksListOptions
export type QuickBooksItemListOptions = QuickBooksListOptions
export type QuickBooksTermListOptions = QuickBooksListOptions
export type QuickBooksClassListOptions = QuickBooksListOptions
export type QuickBooksDepartmentListOptions = QuickBooksListOptions
export type QuickBooksCustomerTypeListOptions = QuickBooksListOptions
export type QuickBooksPaymentMethodListOptions = QuickBooksListOptions
export type QuickBooksTaxCodeListOptions = QuickBooksListOptions
export type QuickBooksTaxRateListOptions = QuickBooksListOptions
export type QuickBooksBudgetListOptions = QuickBooksListOptions
/** TaxAgency has no Active property; `name` matches the agency display name. */
export type QuickBooksTaxAgencyListOptions = Omit<QuickBooksListOptions, "active">
/** CompanyCurrency has no queryable name field; `Code` is filterable only by ID here. */
export type QuickBooksCompanyCurrencyListOptions = Omit<QuickBooksListOptions<never>, "name">

/** Supported transaction query subset; dates are inclusive, calendar dates in YYYY-MM-DD form. */
export interface QuickBooksTransactionListOptions extends QuickBooksPaginationOptions {
  readonly ids?: readonly string[]
  readonly txnDateFrom?: string
  readonly txnDateTo?: string
  /** `MetaData.LastUpdatedTime >=` bound; rows at exactly the bound second can be omitted. */
  readonly updatedSince?: Date
  /** Exact `DocNumber` match. */
  readonly docNumber?: string
  readonly orderBy?: {
    readonly field: "Id" | "TxnDate" | QuickBooksUpdatedField
    readonly direction?: QuickBooksSortDirection
  }
}

export interface QuickBooksCustomerTransactionListOptions extends QuickBooksTransactionListOptions {
  /** Nonempty customer ID array, serialized as `CustomerRef IN (...)`. */
  readonly customerIds?: readonly string[]
}

export interface QuickBooksVendorTransactionListOptions extends QuickBooksTransactionListOptions {
  /** Nonempty vendor ID array, serialized as `VendorRef IN (...)`. */
  readonly vendorIds?: readonly string[]
}

/** `include=invoiceLink` asks QuickBooks for the customer-facing `InvoiceLink`. */
export interface QuickBooksInvoiceLinkOptions {
  /** QuickBooks returns `InvoiceLink` only for eligible invoices (see the package README). */
  readonly includeInvoiceLink?: boolean
}

export interface QuickBooksInvoiceListOptions
  extends QuickBooksCustomerTransactionListOptions,
    QuickBooksInvoiceLinkOptions {}
export type QuickBooksEstimateListOptions = QuickBooksCustomerTransactionListOptions
export type QuickBooksSalesReceiptListOptions = QuickBooksCustomerTransactionListOptions
export type QuickBooksRefundReceiptListOptions = QuickBooksCustomerTransactionListOptions
export type QuickBooksPaymentListOptions = QuickBooksCustomerTransactionListOptions
export type QuickBooksCreditMemoListOptions = QuickBooksCustomerTransactionListOptions
export type QuickBooksBillListOptions = QuickBooksVendorTransactionListOptions
export type QuickBooksBillPaymentListOptions = QuickBooksVendorTransactionListOptions
export type QuickBooksVendorCreditListOptions = QuickBooksVendorTransactionListOptions
export type QuickBooksPurchaseOrderListOptions = QuickBooksVendorTransactionListOptions
/** Purchase `EntityRef` is not queryable, so purchases have no party filter. */
export type QuickBooksPurchaseListOptions = QuickBooksTransactionListOptions
export type QuickBooksDepositListOptions = QuickBooksTransactionListOptions
export type QuickBooksTransferListOptions = QuickBooksTransactionListOptions
export type QuickBooksJournalEntryListOptions = QuickBooksTransactionListOptions
/** QuickBooks does not store DocNumber on card payments. */
export type QuickBooksCreditCardPaymentListOptions = Omit<
  QuickBooksTransactionListOptions,
  "docNumber"
>
export type QuickBooksInventoryAdjustmentListOptions = QuickBooksTransactionListOptions
/** TimeActivity has no DocNumber. */
export type QuickBooksTimeActivityListOptions = Omit<
  QuickBooksCustomerTransactionListOptions,
  "docNumber"
>

/** ReimburseCharge accepts neither TxnDate nor DocNumber predicates. */
export interface QuickBooksReimburseChargeListOptions
  extends QuickBooksReferenceListOptions<never> {
  readonly customerIds?: readonly string[]
}

/** Recurring templates are filtered by template ID, template type and modification time. */
export interface QuickBooksRecurringTransactionListOptions
  extends QuickBooksReferenceListOptions<never> {
  /** Template entity type, e.g. `Bill` or `Invoice`. */
  readonly type?: string
}

/** Not available in US companies; QuickBooks returns error 5030 there. */
export type QuickBooksTaxPaymentListOptions = QuickBooksReferenceListOptions<never>

export interface QuickBooksExchangeRateListOptions extends QuickBooksPaginationOptions {
  /** `MetaData.LastUpdatedTime >=` bound; rows at exactly the bound second can be omitted. */
  readonly updatedSince?: Date
}

export interface QuickBooksTaxClassificationListOptions {
  readonly ids?: readonly string[]
  /** Exact classification name. */
  readonly name?: string
  /** Hierarchy level, e.g. `1` for top-level groups. */
  readonly level?: string
  /** Parent classification ID. */
  readonly parentId?: string
}
