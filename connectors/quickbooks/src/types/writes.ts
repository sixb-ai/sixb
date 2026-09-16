import type { QuickBooksCustomer, QuickBooksReference, QuickBooksVendor } from "./entities"
import type {
  QuickBooksInvoice,
  QuickBooksSalesItemLine,
  QuickBooksSalesLine,
} from "./transactions"

export interface QuickBooksWriteOptions {
  /** Intuit deduplication key (1–50 characters). Persist before sending if recovery is needed.
   * Omitted keys are generated per call. Reuse only for the exact same operation and payload.
   * Writes are never automatically retried, even with a key.
   */
  readonly requestId?: string
}

export interface QuickBooksRevision {
  readonly Id: string
  readonly SyncToken: string
}

type ContactFields =
  | "DisplayName"
  | "Active"
  | "Title"
  | "GivenName"
  | "MiddleName"
  | "FamilyName"
  | "Suffix"
  | "CompanyName"
  | "PrintOnCheckName"
  | "PrimaryPhone"
  | "AlternatePhone"
  | "Mobile"
  | "Fax"
  | "PrimaryEmailAddr"
  | "WebAddr"
  | "BillAddr"
  | "CurrencyRef"

export type QuickBooksCustomerCreate = Pick<
  QuickBooksCustomer,
  | ContactFields
  | "ShipAddr"
  | "Notes"
  | "Job"
  | "BillWithParent"
  | "ParentRef"
  | "SalesTermRef"
  | "PaymentMethodRef"
  | "DefaultTaxCodeRef"
  | "Taxable"
  | "TaxExemptionReasonId"
  | "PreferredDeliveryMethod"
  | "ResaleNum"
  | "CustomerTypeRef"
>

/** Always a sparse update. Omitted fields are retained by QuickBooks. */
export type QuickBooksCustomerUpdate = QuickBooksRevision & Partial<QuickBooksCustomerCreate>

export type QuickBooksVendorCreate = Pick<
  QuickBooksVendor,
  ContactFields | "AcctNum" | "Vendor1099" | "TermRef" | "TaxIdentifier" | "BillRate"
>
export type QuickBooksVendorUpdate = QuickBooksRevision & Partial<QuickBooksVendorCreate>

/** Writable sales lines. Item lines require an amount and an item reference. */
export type QuickBooksInvoiceLine =
  | (QuickBooksSalesItemLine & {
      readonly Amount: number
      readonly SalesItemLineDetail: NonNullable<QuickBooksSalesItemLine["SalesItemLineDetail"]> & {
        readonly ItemRef: QuickBooksReference
      }
    })
  | Exclude<QuickBooksSalesLine, QuickBooksSalesItemLine>

type InvoiceFields = Pick<
  QuickBooksInvoice,
  | "TxnDate"
  | "DocNumber"
  | "PrivateNote"
  | "CurrencyRef"
  | "ExchangeRate"
  | "DepartmentRef"
  | "ClassRef"
  | "CustomField"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "BillAddr"
  | "ShipAddr"
  | "BillEmail"
  | "BillEmailCc"
  | "BillEmailBcc"
  | "CustomerMemo"
  | "SalesTermRef"
  | "ShipMethodRef"
  | "ShipDate"
  | "TrackingNum"
  | "PrintStatus"
  | "EmailStatus"
  | "ApplyTaxAfterDiscount"
  | "DueDate"
  | "Deposit"
  | "DepositToAccountRef"
  | "AllowOnlineCreditCardPayment"
  | "AllowOnlineACHPayment"
>

export type QuickBooksInvoiceCreate = InvoiceFields & {
  readonly CustomerRef: QuickBooksReference
  readonly Line: readonly QuickBooksInvoiceLine[]
}

/** Sparse update; supplying Line follows Intuit's line-ID replacement semantics. */
export type QuickBooksInvoiceUpdate = QuickBooksRevision & Partial<QuickBooksInvoiceCreate>

export interface QuickBooksInvoiceSendOptions extends QuickBooksWriteOptions {
  /** Omit to use the invoice's BillEmail.Address. Intuit may update BillEmail when supplied. */
  readonly sendTo?: string
}

export interface QuickBooksInvoiceDeleteResult {
  readonly Id: string
  readonly status: "Deleted"
}
