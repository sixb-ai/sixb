import type { QuickBooksCompanyInfo } from "../types"
import type {
  QuickBooksAccount,
  QuickBooksCustomer,
  QuickBooksEmailMessage,
  QuickBooksItem,
  QuickBooksReference,
  QuickBooksTerm,
  QuickBooksVendor,
} from "./entities"
import type {
  QuickBooksAccountExpenseLine,
  QuickBooksBill,
  QuickBooksBillPayment,
  QuickBooksCreditMemo,
  QuickBooksDescriptionLine,
  QuickBooksInvoice,
  QuickBooksItemExpenseLine,
  QuickBooksLinkedTransaction,
  QuickBooksPayment,
  QuickBooksSalesItemLine,
  QuickBooksSalesLine,
  QuickBooksVendorCredit,
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

export interface QuickBooksDeleteResult {
  readonly Id: string
  readonly status: "Deleted"
}

export interface QuickBooksPaymentSendOptions extends QuickBooksWriteOptions {
  /** Payment receipt emails require an explicit recipient. */
  readonly sendTo: string
}
export type QuickBooksCreditMemoSendOptions = QuickBooksInvoiceSendOptions

type TransactionFields = "TxnDate" | "PrivateNote" | "CurrencyRef" | "ExchangeRate"

/** Payment allocations are replaced as a collection, including on sparse updates. */
export interface QuickBooksAllocationLine {
  readonly Amount: number
  readonly LinkedTxn: readonly QuickBooksLinkedTransaction[]
}

export type QuickBooksPaymentCreate = Pick<
  QuickBooksPayment,
  | TransactionFields
  | "ARAccountRef"
  | "DepositToAccountRef"
  | "PaymentMethodRef"
  | "PaymentRefNum"
  | "ProjectRef"
> & {
  readonly CustomerRef: QuickBooksReference
  readonly TotalAmt: number
  readonly Line?: readonly QuickBooksAllocationLine[]
}
export type QuickBooksPaymentUpdate = QuickBooksRevision & Partial<QuickBooksPaymentCreate>

export type QuickBooksCreditMemoCreate = Pick<
  QuickBooksCreditMemo,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "ClassRef"
  | "CustomField"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "BillAddr"
  | "ShipAddr"
  | "BillEmail"
  | "CustomerMemo"
  | "SalesTermRef"
  | "PrintStatus"
  | "EmailStatus"
  | "ApplyTaxAfterDiscount"
  | "PaymentMethodRef"
> & {
  readonly CustomerRef: QuickBooksReference
  readonly Line: readonly QuickBooksInvoiceLine[]
}
/** Retain the required customer and line fields when updating. */
export type QuickBooksCreditMemoUpdate = QuickBooksRevision & QuickBooksCreditMemoCreate

export type QuickBooksExpenseWriteLine =
  | (QuickBooksAccountExpenseLine & {
      readonly Amount: number
      readonly AccountBasedExpenseLineDetail: NonNullable<
        QuickBooksAccountExpenseLine["AccountBasedExpenseLineDetail"]
      > & { readonly AccountRef: QuickBooksReference }
    })
  | (QuickBooksItemExpenseLine & {
      readonly Amount: number
      readonly ItemBasedExpenseLineDetail: NonNullable<
        QuickBooksItemExpenseLine["ItemBasedExpenseLineDetail"]
      > & { readonly ItemRef: QuickBooksReference }
    })
  | QuickBooksDescriptionLine

export type QuickBooksBillCreate = Pick<
  QuickBooksBill,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "APAccountRef"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "DueDate"
  | "SalesTermRef"
  | "VendorAddr"
> & {
  readonly VendorRef: QuickBooksReference
  readonly Line: readonly QuickBooksExpenseWriteLine[]
}
/** QuickBooks requires VendorRef and Line even with sparse: true. */
export type QuickBooksBillUpdate = QuickBooksRevision & QuickBooksBillCreate

export type QuickBooksVendorCreditCreate = Pick<
  QuickBooksVendorCredit,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "APAccountRef"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
> & {
  readonly VendorRef: QuickBooksReference
  readonly Line: readonly QuickBooksExpenseWriteLine[]
}
export type QuickBooksVendorCreditUpdate = QuickBooksRevision & QuickBooksVendorCreditCreate

export type QuickBooksBillPaymentCreate = Pick<
  QuickBooksBillPayment,
  TransactionFields | "DocNumber" | "DepartmentRef" | "APAccountRef"
> & {
  readonly VendorRef: QuickBooksReference
  readonly TotalAmt: number
  readonly Line: readonly QuickBooksAllocationLine[]
} & (
    | {
        readonly PayType: "Check"
        readonly CheckPayment: {
          readonly BankAccountRef: QuickBooksReference
          readonly PrintStatus?: string
        }
        readonly CreditCardPayment?: never
      }
    | {
        readonly PayType: "CreditCard"
        readonly CreditCardPayment: { readonly CCAccountRef: QuickBooksReference }
        readonly CheckPayment?: never
      }
  )
export type QuickBooksBillPaymentUpdate = QuickBooksRevision & QuickBooksBillPaymentCreate

export type QuickBooksAccountCreate = Pick<
  QuickBooksAccount,
  | "Name"
  | "Active"
  | "Description"
  | "AcctNum"
  | "SubAccount"
  | "ParentRef"
  | "CurrencyRef"
  | "TaxCodeRef"
> &
  (
    | { readonly AccountType: string; readonly AccountSubType?: string }
    | { readonly AccountType?: string; readonly AccountSubType: string }
  )
export type QuickBooksAccountUpdate = QuickBooksRevision & Partial<QuickBooksAccountCreate>

type ItemFields = Pick<
  QuickBooksItem,
  | "Name"
  | "Active"
  | "Description"
  | "Sku"
  | "SubItem"
  | "ParentRef"
  | "Taxable"
  | "UnitPrice"
  | "PurchaseCost"
  | "PurchaseDesc"
  | "ExpenseAccountRef"
  | "PrefVendorRef"
  | "SalesTaxCodeRef"
  | "PurchaseTaxCodeRef"
  | "SalesTaxIncluded"
  | "PurchaseTaxIncluded"
>
export type QuickBooksItemCreate =
  | (ItemFields & {
      readonly Type: "Service" | "NonInventory"
      readonly IncomeAccountRef: QuickBooksReference
    })
  | (ItemFields & {
      readonly Type: "Inventory"
      readonly IncomeAccountRef: QuickBooksReference
      readonly ExpenseAccountRef: QuickBooksReference
      readonly AssetAccountRef: QuickBooksReference
      readonly TrackQtyOnHand: true
      readonly QtyOnHand: number
      readonly InvStartDate: string
    })
  | (Pick<QuickBooksItem, "Name" | "SubItem" | "ParentRef"> & { readonly Type: "Category" })

/** Group (bundle) creation is unsupported by Intuit. Category activation is unsupported. */
export type QuickBooksItemUpdate = QuickBooksRevision &
  (
    | (Partial<ItemFields> & {
        readonly Type: "Service" | "NonInventory"
        readonly IncomeAccountRef?: QuickBooksReference
      })
    | (Partial<ItemFields> & {
        readonly Type: "Inventory"
        readonly IncomeAccountRef?: QuickBooksReference
        readonly AssetAccountRef?: QuickBooksReference
        readonly TrackQtyOnHand?: boolean
        readonly QtyOnHand?: number
        readonly InvStartDate?: string
      })
    | (Partial<Pick<QuickBooksItem, "Name" | "SubItem" | "ParentRef">> & {
        readonly Type: "Category"
      })
  )
export type QuickBooksItemRevision = QuickBooksRevision & {
  readonly Type: "Service" | "NonInventory" | "Inventory"
}

type TermFields = Pick<
  QuickBooksTerm,
  "Name" | "Active" | "DiscountPercent" | "DiscountDays" | "DueNextMonthDays" | "DiscountDayOfMonth"
>
type TermDueRule =
  | { readonly DueDays: number; readonly DayOfMonthDue?: never }
  | { readonly DayOfMonthDue: number; readonly DueDays?: never }
export type QuickBooksTermCreate = TermFields & TermDueRule
/** Retain the due-date rule even on sparse edits; activation methods only need a revision. */
export type QuickBooksTermUpdate = QuickBooksRevision & Partial<TermFields> & TermDueRule

export type QuickBooksCompanyInfoUpdate = QuickBooksRevision &
  Partial<
    Pick<
      QuickBooksCompanyInfo,
      | "CompanyName"
      | "LegalName"
      | "CompanyAddr"
      | "CustomerCommunicationAddr"
      | "LegalAddr"
      | "PrimaryPhone"
      | "Email"
      | "WebAddr"
    >
  >

/** Sparse updates to supported groups. SalesFormsPrefs is excluded because Intuit clears
 * DefaultCustomerMessage on partial edits and rejects attempts to write it back.
 */
export interface QuickBooksPreferencesUpdate extends QuickBooksRevision {
  readonly EmailMessagesPrefs?: {
    readonly InvoiceMessage?: QuickBooksEmailMessage
    readonly EstimateMessage?: QuickBooksEmailMessage
    readonly SalesReceiptMessage?: QuickBooksEmailMessage
    readonly StatementMessage?: QuickBooksEmailMessage
  }
  readonly ProductAndServicesPrefs?: {
    readonly ForSales?: boolean
    readonly ForPurchase?: boolean
    readonly QuantityOnHand?: boolean
    readonly QuantityWithPriceAndRate?: boolean
    readonly RevenueRecognitionEnabled?: boolean
    readonly RecognitionFrequencyType?: "Daily" | "Weekly" | "Monthly"
  }
  readonly ReportPrefs?: { readonly ReportBasis?: "Cash" | "Accrual" }
  readonly AccountingInfoPrefs?: {
    readonly ClassTrackingPerTxn?: boolean
    readonly ClassTrackingPerTxnLine?: boolean
    readonly TrackDepartments?: boolean
    readonly CustomerTerminology?: string
    readonly DepartmentTerminology?: string
  }
  readonly VendorAndPurchasesPrefs?: {
    readonly DefaultMarkupAccount?: QuickBooksReference
    readonly TrackingByCustomer?: boolean
    readonly DefaultTerms?: QuickBooksReference
    readonly BillableExpenseTracking?: boolean
    readonly DefaultMarkup?: number
  }
  readonly TimeTrackingPrefs?: {
    readonly ShowBillRateToAll?: boolean
    readonly UseServices?: boolean
    readonly BillCustomers?: boolean
  }
}
