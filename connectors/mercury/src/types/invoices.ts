import type {
  MercuryCurrencyCode,
  MercuryCursorOptions,
  MercuryDay,
  MercuryPageCursors,
  MercuryTimestamp,
} from "./common"

export type MercuryInvoiceStatus = "Unpaid" | "Paid" | "Cancelled" | "Processing"

export interface MercuryInvoiceLineItem {
  readonly name: string
  /** Price of one unit before sales tax. */
  readonly unitPrice: number
  readonly quantity: number
  /** Sales tax rate applied to this item. */
  readonly salesTaxRate?: number | null
}

export interface MercuryInvoice {
  readonly id: string
  /** Payer-facing invoice number. */
  readonly invoiceNumber: string
  readonly status: MercuryInvoiceStatus
  readonly customerId: string
  /** Total of all line items plus taxes. */
  readonly amount: number
  readonly currencyCode: MercuryCurrencyCode
  readonly lineItems: readonly MercuryInvoiceLineItem[]
  readonly dueDate: MercuryDay
  /**
   * Date the invoice covers, set by its creator — often a service or sale date rather than the
   * date the invoice was written.
   */
  readonly invoiceDate: MercuryDay
  readonly servicePeriodStartDate?: MercuryDay | null
  readonly servicePeriodEndDate?: MercuryDay | null
  /** Mercury checking or savings account that receives payments. */
  readonly destinationAccountId: string
  readonly ccEmails: readonly string[]
  readonly creditCardEnabled: boolean
  readonly achDebitEnabled: boolean
  /**
   * Whether payment instructions expose the destination account's real account and routing
   * numbers instead of virtual ones.
   */
  readonly useRealAccountNumber: boolean
  /** Public slug used to build the pay-page and PDF URLs. */
  readonly slug: string
  readonly payerMemo?: string | null
  /** Visible to the organization but never to payers. */
  readonly internalNote?: string | null
  readonly poNumber?: string | null
  readonly createdAt: MercuryTimestamp
  readonly updatedAt: MercuryTimestamp
  readonly canceledAt?: MercuryTimestamp | null
}

export interface MercuryInvoicesResponse {
  readonly invoices: readonly MercuryInvoice[]
  readonly page: MercuryPageCursors
}

export type MercuryInvoiceListOptions = MercuryCursorOptions

/** Whether Mercury emails the invoice to payers on creation. Defaults to sending immediately. */
export type MercurySendEmailOption = "DontSend" | "SendNow"

export interface MercuryCreateInvoiceInput {
  readonly customerId: string
  readonly destinationAccountId: string
  readonly dueDate: MercuryDay
  readonly invoiceDate: MercuryDay
  readonly lineItems: readonly MercuryInvoiceLineItem[]
  readonly ccEmails: readonly string[]
  readonly creditCardEnabled: boolean
  readonly achDebitEnabled: boolean
  readonly useRealAccountNumber: boolean
  /** Defaults to USD when omitted. */
  readonly currencyCode?: MercuryCurrencyCode | null
  /** Mercury assigns the next number in sequence when omitted. */
  readonly invoiceNumber?: string | null
  readonly servicePeriodStartDate?: MercuryDay | null
  readonly servicePeriodEndDate?: MercuryDay | null
  readonly payerMemo?: string | null
  readonly internalNote?: string | null
  readonly poNumber?: string | null
  readonly sendEmailOption?: MercurySendEmailOption | null
}

/**
 * Invoice update payload. Mercury replaces rather than patches, so the required fields must be
 * resent even when unchanged — read the invoice first and spread it if you only want to change
 * one thing. Notably, `customerId` and `destinationAccountId` cannot be changed after creation.
 */
export interface MercuryUpdateInvoiceInput {
  readonly invoiceNumber: string
  readonly dueDate: MercuryDay
  readonly invoiceDate: MercuryDay
  readonly lineItems: readonly MercuryInvoiceLineItem[]
  readonly ccEmails: readonly string[]
  readonly creditCardEnabled: boolean
  readonly achDebitEnabled: boolean
  readonly useRealAccountNumber: boolean
  readonly servicePeriodStartDate?: MercuryDay | null
  readonly servicePeriodEndDate?: MercuryDay | null
  readonly payerMemo?: string | null
  readonly internalNote?: string | null
  readonly poNumber?: string | null
}
