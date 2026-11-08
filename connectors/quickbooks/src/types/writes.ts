import type { QuickBooksCompanyInfo } from "../types"
import type {
  QuickBooksAccount,
  QuickBooksClass,
  QuickBooksCustomer,
  QuickBooksDepartment,
  QuickBooksEmailMessage,
  QuickBooksEmployee,
  QuickBooksItem,
  QuickBooksPaymentMethod,
  QuickBooksReference,
  QuickBooksTerm,
  QuickBooksVendor,
} from "./entities"
import type {
  QuickBooksAccountExpenseLine,
  QuickBooksBill,
  QuickBooksBillPayment,
  QuickBooksCreditMemo,
  QuickBooksDeposit,
  QuickBooksDepositLine,
  QuickBooksDescriptionLine,
  QuickBooksEstimate,
  QuickBooksEstimateStatus,
  QuickBooksInvoice,
  QuickBooksItemExpenseLine,
  QuickBooksJournalEntry,
  QuickBooksJournalEntryLine,
  QuickBooksLinkedTransaction,
  QuickBooksPayment,
  QuickBooksPurchase,
  QuickBooksPurchaseOrder,
  QuickBooksRefundReceipt,
  QuickBooksSalesItemLine,
  QuickBooksSalesLine,
  QuickBooksSalesReceipt,
  QuickBooksTimeActivity,
  QuickBooksTransfer,
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
  | "ProjectRef"
> & {
  /** Link an accepted estimate (`TxnType: "Estimate"`) or other source transaction. */
  readonly LinkedTxn?: readonly QuickBooksLinkedTransaction[]
}

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

type EstimateFields = Pick<
  QuickBooksEstimate,
  | "TxnDate"
  | "DocNumber"
  | "PrivateNote"
  | "CurrencyRef"
  | "ExchangeRate"
  | "DepartmentRef"
  | "ClassRef"
  | "ProjectRef"
  | "CustomField"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "BillAddr"
  | "ShipAddr"
  | "ShipFromAddr"
  | "BillEmail"
  | "BillEmailCc"
  | "BillEmailBcc"
  | "CustomerMemo"
  | "SalesTermRef"
  | "ShipMethodRef"
  | "ShipDate"
  | "PrintStatus"
  | "EmailStatus"
  | "ApplyTaxAfterDiscount"
  | "DueDate"
  | "ExpirationDate"
  | "AcceptedBy"
  | "AcceptedDate"
> & { readonly TxnStatus?: QuickBooksEstimateStatus }

export type QuickBooksEstimateCreate = EstimateFields & {
  readonly CustomerRef: QuickBooksReference
  readonly Line: readonly QuickBooksInvoiceLine[]
}

/** Sparse update; supplying Line follows Intuit's line-ID replacement semantics. */
export type QuickBooksEstimateUpdate = QuickBooksRevision & Partial<QuickBooksEstimateCreate>

export type QuickBooksEstimateSendOptions = QuickBooksInvoiceSendOptions

export interface QuickBooksInvoiceDeleteResult {
  readonly Id: string
  readonly status: "Deleted"
}

export interface QuickBooksDeleteResult {
  readonly Id: string
  readonly status: "Deleted"
}

type ReceiptFields =
  | "CustomerRef"
  | "TxnDate"
  | "DocNumber"
  | "PrivateNote"
  | "CurrencyRef"
  | "ExchangeRate"
  | "DepartmentRef"
  | "ClassRef"
  | "ProjectRef"
  | "CustomField"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "BillAddr"
  | "ShipAddr"
  | "ShipFromAddr"
  | "BillEmail"
  | "CustomerMemo"
  | "ShipMethodRef"
  | "ShipDate"
  | "TrackingNum"
  | "PrintStatus"
  | "ApplyTaxAfterDiscount"
  | "DepositToAccountRef"
  | "PaymentMethodRef"
  | "PaymentRefNum"

/** CustomerRef is optional: a sales receipt can record an anonymous sale. */
export type QuickBooksSalesReceiptCreate = Pick<
  QuickBooksSalesReceipt,
  ReceiptFields | "EmailStatus"
> & { readonly Line: readonly QuickBooksInvoiceLine[] }
/** Sparse update; supplying Line follows Intuit's line-ID replacement semantics. */
export type QuickBooksSalesReceiptUpdate = QuickBooksRevision &
  Partial<QuickBooksSalesReceiptCreate>
export type QuickBooksSalesReceiptSendOptions = QuickBooksInvoiceSendOptions

/** DepositToAccountRef is the account the refund is paid from. */
export type QuickBooksRefundReceiptCreate = Pick<QuickBooksRefundReceipt, ReceiptFields> & {
  readonly Line: readonly QuickBooksInvoiceLine[]
  readonly DepositToAccountRef: QuickBooksReference
}
export type QuickBooksRefundReceiptUpdate = QuickBooksRevision &
  Partial<QuickBooksRefundReceiptCreate>

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

export type QuickBooksPurchaseCreate = Pick<
  QuickBooksPurchase,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "EntityRef"
  | "Credit"
  | "RemitToAddr"
  | "PrintStatus"
  | "PaymentMethodRef"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
> & {
  readonly PaymentType: "Cash" | "Check" | "CreditCard"
  readonly AccountRef: QuickBooksReference
  readonly Line: readonly QuickBooksExpenseWriteLine[]
}
/** QuickBooks requires PaymentType on every Purchase update, including sparse ones (error 2020). */
export type QuickBooksPurchaseUpdate = QuickBooksRevision &
  Partial<QuickBooksPurchaseCreate> &
  Pick<QuickBooksPurchaseCreate, "PaymentType">

export type QuickBooksPurchaseOrderCreate = Pick<
  QuickBooksPurchaseOrder,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "ClassRef"
  | "APAccountRef"
  | "POEmail"
  | "VendorAddr"
  | "ShipAddr"
  | "ShipTo"
  | "ShipMethodRef"
  | "DueDate"
  | "SalesTermRef"
  | "Memo"
  | "EmailStatus"
  | "PrintStatus"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
  | "CustomField"
> & {
  readonly VendorRef: QuickBooksReference
  readonly Line: readonly QuickBooksExpenseWriteLine[]
  readonly POStatus?: "Open" | "Closed"
}
export type QuickBooksPurchaseOrderUpdate = QuickBooksRevision &
  Partial<QuickBooksPurchaseOrderCreate>
export type QuickBooksPurchaseOrderSendOptions = QuickBooksInvoiceSendOptions

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

export type QuickBooksEmployeeCreate = Pick<
  QuickBooksEmployee,
  | "DisplayName"
  | "Active"
  | "Title"
  | "GivenName"
  | "MiddleName"
  | "FamilyName"
  | "Suffix"
  | "PrintOnCheckName"
  | "PrimaryPhone"
  | "Mobile"
  | "PrimaryEmailAddr"
  | "PrimaryAddr"
  | "EmployeeNumber"
  | "BillableTime"
  | "BillRate"
  | "CostRate"
  | "BirthDate"
  | "Gender"
  | "HiredDate"
  | "ReleasedDate"
>
/** Always a sparse update. Employees are deactivated, not deleted. */
export type QuickBooksEmployeeUpdate = QuickBooksRevision & Partial<QuickBooksEmployeeCreate>

export type QuickBooksClassCreate = Pick<
  QuickBooksClass,
  "Name" | "Active" | "SubClass" | "ParentRef"
>
/** QuickBooks requires Name on every Class update, including sparse ones (error 2020). */
export type QuickBooksClassUpdate = QuickBooksRevision &
  Partial<QuickBooksClassCreate> & { readonly Name: string }
/** Class activation changes also require the current Name. */
export type QuickBooksClassRevision = QuickBooksRevision & { readonly Name: string }

export type QuickBooksDepartmentCreate = Pick<
  QuickBooksDepartment,
  "Name" | "Active" | "SubDepartment" | "ParentRef"
>
/** QuickBooks requires Name on every Department update, including sparse ones (error 2020). */
export type QuickBooksDepartmentUpdate = QuickBooksRevision &
  Partial<QuickBooksDepartmentCreate> & { readonly Name: string }
/** Department activation changes also require the current Name. */
export type QuickBooksDepartmentRevision = QuickBooksRevision & { readonly Name: string }

export type QuickBooksPaymentMethodCreate = Pick<QuickBooksPaymentMethod, "Name" | "Active"> & {
  readonly Type?: "CREDIT_CARD" | "NON_CREDIT_CARD"
}
export type QuickBooksPaymentMethodUpdate = QuickBooksRevision &
  Partial<QuickBooksPaymentMethodCreate>

type TimeActivityFields = Pick<
  QuickBooksTimeActivity,
  | "TxnDate"
  | "CustomerRef"
  | "ProjectRef"
  | "ItemRef"
  | "ClassRef"
  | "DepartmentRef"
  | "PayrollItemRef"
  | "Taxable"
  | "HourlyRate"
  | "CostRate"
  | "Hours"
  | "Minutes"
  | "Seconds"
  | "BreakHours"
  | "BreakMinutes"
  | "BreakSeconds"
  | "StartTime"
  | "EndTime"
  | "Description"
> & { readonly BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled" }

/** Who did the work: an employee or a vendor, matching NameOf. */
export type QuickBooksTimeActivityWorker =
  | {
      readonly NameOf: "Employee"
      readonly EmployeeRef: QuickBooksReference
      readonly VendorRef?: never
    }
  | {
      readonly NameOf: "Vendor"
      readonly VendorRef: QuickBooksReference
      readonly EmployeeRef?: never
    }

/** Supply a duration (Hours/Minutes) or both StartTime and EndTime. */
export type QuickBooksTimeActivityCreate = TimeActivityFields & QuickBooksTimeActivityWorker
export type QuickBooksTimeActivityUpdate = QuickBooksRevision &
  Partial<TimeActivityFields> &
  (QuickBooksTimeActivityWorker | { readonly NameOf?: never })

/** A direct deposit line from an account, or a line depositing a linked payment. */
export type QuickBooksDepositWriteLine =
  | (QuickBooksDepositLine & {
      readonly Amount: number
      readonly DetailType: "DepositLineDetail"
      readonly DepositLineDetail: NonNullable<QuickBooksDepositLine["DepositLineDetail"]> & {
        readonly AccountRef: QuickBooksReference
      }
    })
  | (Pick<QuickBooksDepositLine, "Id" | "Description" | "LineNum"> & {
      readonly Amount: number
      readonly LinkedTxn: readonly QuickBooksLinkedTransaction[]
    })

export type QuickBooksDepositCreate = Pick<
  QuickBooksDeposit,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "CashBack"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
> & {
  readonly DepositToAccountRef: QuickBooksReference
  readonly Line: readonly QuickBooksDepositWriteLine[]
}
/** QuickBooks requires DepositToAccountRef on every Deposit update, even sparse (error 2020). */
export type QuickBooksDepositUpdate = QuickBooksRevision &
  Partial<QuickBooksDepositCreate> &
  Pick<QuickBooksDepositCreate, "DepositToAccountRef">

export type QuickBooksTransferCreate = Pick<QuickBooksTransfer, TransactionFields | "DocNumber"> & {
  readonly FromAccountRef: QuickBooksReference
  readonly ToAccountRef: QuickBooksReference
  readonly Amount: number
}
/** QuickBooks requires both accounts and Amount on every Transfer update (error 2020). */
export type QuickBooksTransferUpdate = QuickBooksRevision & QuickBooksTransferCreate

export type QuickBooksJournalEntryWriteLine = QuickBooksJournalEntryLine & {
  readonly Amount: number
  readonly DetailType: "JournalEntryLineDetail"
  readonly JournalEntryLineDetail: NonNullable<
    QuickBooksJournalEntryLine["JournalEntryLineDetail"]
  > & {
    readonly PostingType: "Debit" | "Credit"
    readonly AccountRef: QuickBooksReference
  }
}

/** QuickBooks rejects entries whose debits and credits do not balance. */
export type QuickBooksJournalEntryCreate = Pick<
  QuickBooksJournalEntry,
  | TransactionFields
  | "DocNumber"
  | "DepartmentRef"
  | "Adjustment"
  | "TxnTaxDetail"
  | "GlobalTaxCalculation"
> & { readonly Line: readonly QuickBooksJournalEntryWriteLine[] }
/** Sparse update; supplying Line replaces the entry's lines by Intuit's line-ID semantics. */
export type QuickBooksJournalEntryUpdate = QuickBooksRevision &
  Partial<QuickBooksJournalEntryCreate>
