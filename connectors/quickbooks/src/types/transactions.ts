import type { QuickBooksAddress } from "../types"
import type { QuickBooksCustomField, QuickBooksEntity, QuickBooksReference } from "./entities"

export interface QuickBooksLinkedTransaction {
  readonly TxnId: string
  /** Provider transaction type, e.g. Invoice, Payment, CreditMemo, Bill, VendorCredit. */
  readonly TxnType: string
  readonly TxnLineId?: string
}

export interface QuickBooksLineBase {
  readonly Id?: string
  readonly LineNum?: number
  readonly Description?: string
  readonly Amount?: number
  readonly LinkedTxn?: readonly QuickBooksLinkedTransaction[]
  readonly CustomField?: readonly QuickBooksCustomField[]
  /** Opaque provider extension data, retained without interpretation. */
  readonly LineEx?: Readonly<Record<string, unknown>>
}

export interface QuickBooksSalesItemLine extends QuickBooksLineBase {
  readonly DetailType: "SalesItemLineDetail"
  readonly SalesItemLineDetail?: {
    readonly ItemRef?: QuickBooksReference
    readonly ClassRef?: QuickBooksReference
    readonly UnitPrice?: number
    readonly Qty?: number
    readonly TaxCodeRef?: QuickBooksReference
    readonly ItemAccountRef?: QuickBooksReference
    readonly ServiceDate?: string
    readonly DiscountRate?: number
    readonly DiscountAmt?: number
    readonly TaxInclusiveAmt?: number
  }
}

export interface QuickBooksDiscountLine extends QuickBooksLineBase {
  readonly DetailType: "DiscountLineDetail"
  readonly DiscountLineDetail?: {
    readonly PercentBased?: boolean
    readonly DiscountPercent?: number
    readonly DiscountAccountRef?: QuickBooksReference
    readonly ClassRef?: QuickBooksReference
    readonly TaxCodeRef?: QuickBooksReference
  }
}

export interface QuickBooksSubtotalLine extends QuickBooksLineBase {
  readonly DetailType: "SubTotalLineDetail"
  readonly SubTotalLineDetail?: { readonly ItemRef?: QuickBooksReference }
}

export interface QuickBooksDescriptionLine extends QuickBooksLineBase {
  readonly DetailType: "DescriptionOnly"
  readonly DescriptionLineDetail?: {
    readonly ServiceDate?: string
    readonly TaxCodeRef?: QuickBooksReference
  }
}

export interface QuickBooksGroupLine extends QuickBooksLineBase {
  readonly DetailType: "GroupLineDetail"
  readonly GroupLineDetail?: {
    readonly GroupItemRef?: QuickBooksReference
    readonly Quantity?: number
    readonly Line?: readonly QuickBooksSalesLine[]
  }
}

export type QuickBooksSalesLine =
  | QuickBooksSalesItemLine
  | QuickBooksDiscountLine
  | QuickBooksSubtotalLine
  | QuickBooksDescriptionLine
  | QuickBooksGroupLine

export interface QuickBooksAccountExpenseLine extends QuickBooksLineBase {
  readonly DetailType: "AccountBasedExpenseLineDetail"
  readonly AccountBasedExpenseLineDetail?: {
    readonly AccountRef?: QuickBooksReference
    readonly CustomerRef?: QuickBooksReference
    readonly ClassRef?: QuickBooksReference
    readonly TaxCodeRef?: QuickBooksReference
    readonly BillableStatus?: string
    readonly TaxAmount?: number
    readonly TaxInclusiveAmt?: number
    readonly MarkupInfo?: QuickBooksMarkupInfo
  }
}

export interface QuickBooksItemExpenseLine extends QuickBooksLineBase {
  readonly DetailType: "ItemBasedExpenseLineDetail"
  readonly ItemBasedExpenseLineDetail?: {
    readonly ItemRef?: QuickBooksReference
    readonly CustomerRef?: QuickBooksReference
    readonly ClassRef?: QuickBooksReference
    readonly UnitPrice?: number
    readonly Qty?: number
    readonly TaxCodeRef?: QuickBooksReference
    readonly BillableStatus?: string
    readonly TaxInclusiveAmt?: number
    readonly MarkupInfo?: QuickBooksMarkupInfo
  }
}

export interface QuickBooksMarkupInfo {
  readonly PercentBased?: boolean
  readonly Percent?: number
  readonly MarkUpIncomeAccountRef?: QuickBooksReference
}

export type QuickBooksExpenseLine =
  | QuickBooksAccountExpenseLine
  | QuickBooksItemExpenseLine
  | QuickBooksDescriptionLine

export interface QuickBooksTaxDetail {
  readonly TxnTaxCodeRef?: QuickBooksReference
  readonly TotalTax?: number
  readonly TaxLine?: readonly (QuickBooksLineBase & {
    readonly DetailType?: "TaxLineDetail"
    readonly TaxLineDetail?: {
      readonly TaxRateRef?: QuickBooksReference
      readonly PercentBased?: boolean
      readonly TaxPercent?: number
      readonly NetAmountTaxable?: number
      readonly TaxInclusiveAmount?: number
      readonly OverrideDeltaAmount?: number
    }
  })[]
}

export interface QuickBooksTransaction extends QuickBooksEntity {
  readonly TxnDate?: string
  readonly DocNumber?: string
  readonly PrivateNote?: string
  readonly CurrencyRef?: QuickBooksReference
  readonly ExchangeRate?: number
  readonly DepartmentRef?: QuickBooksReference
  readonly LinkedTxn?: readonly QuickBooksLinkedTransaction[]
  readonly CustomField?: readonly QuickBooksCustomField[]
  readonly TotalAmt?: number
  readonly HomeTotalAmt?: number
}

interface QuickBooksSalesTransaction extends QuickBooksTransaction {
  readonly CustomerRef?: QuickBooksReference
  readonly ProjectRef?: QuickBooksReference
  readonly ClassRef?: QuickBooksReference
  readonly Line?: readonly QuickBooksSalesLine[]
  readonly TxnTaxDetail?: QuickBooksTaxDetail
  readonly GlobalTaxCalculation?: string
  readonly BillAddr?: QuickBooksAddress
  readonly ShipAddr?: QuickBooksAddress
  readonly ShipFromAddr?: QuickBooksAddress
  readonly FreeFormAddress?: boolean
  readonly BillEmail?: { readonly Address?: string }
  readonly BillEmailCc?: { readonly Address?: string }
  readonly BillEmailBcc?: { readonly Address?: string }
  readonly CustomerMemo?: { readonly value: string }
  readonly SalesTermRef?: QuickBooksReference
  readonly ShipMethodRef?: QuickBooksReference
  readonly ShipDate?: string
  readonly TrackingNum?: string
  readonly PrintStatus?: string
  readonly EmailStatus?: string
  readonly ApplyTaxAfterDiscount?: boolean
  readonly Balance?: number
  readonly DeliveryInfo?: { readonly DeliveryType?: string; readonly DeliveryTime?: string }
}

export interface QuickBooksInvoice extends QuickBooksSalesTransaction {
  readonly DueDate?: string
  readonly HomeBalance?: number
  readonly Deposit?: number
  readonly DepositToAccountRef?: QuickBooksReference
  readonly AllowOnlinePayment?: boolean
  readonly AllowOnlineCreditCardPayment?: boolean
  readonly AllowOnlineACHPayment?: boolean
  readonly AllowIPNPayment?: boolean
  readonly InvoiceLink?: string
  readonly RecurDataRef?: QuickBooksReference
}

/** Writable estimate statuses. */
export type QuickBooksEstimateStatus = "Pending" | "Accepted" | "Closed" | "Rejected"

export interface QuickBooksEstimate extends QuickBooksSalesTransaction {
  /** QuickBooks sets `Converted` (observed live) when an invoice links the estimate. */
  readonly TxnStatus?: QuickBooksEstimateStatus | "Converted" | (string & {})
  readonly ExpirationDate?: string
  readonly AcceptedBy?: string
  readonly AcceptedDate?: string
  readonly DueDate?: string
  readonly RecurDataRef?: QuickBooksReference
  readonly TaxExemptionRef?: QuickBooksReference
  readonly TransactionLocationType?: string
}

export interface QuickBooksCreditMemo extends QuickBooksSalesTransaction {
  readonly RemainingCredit?: number
  readonly PaymentMethodRef?: QuickBooksReference
}

/** Opaque card-processing details retained without interpretation. */
export interface QuickBooksCreditCardPaymentInfo {
  readonly CreditChargeInfo?: Readonly<Record<string, unknown>>
  readonly CreditChargeResponse?: Readonly<Record<string, unknown>>
}

/** A sale paid at the time of sale; it records money received rather than an open balance. */
export interface QuickBooksSalesReceipt extends QuickBooksSalesTransaction {
  readonly DepositToAccountRef?: QuickBooksReference
  readonly PaymentMethodRef?: QuickBooksReference
  readonly PaymentRefNum?: string
  readonly CreditCardPayment?: QuickBooksCreditCardPaymentInfo
  readonly TxnSource?: string
  readonly HomeBalance?: number
  readonly RecurDataRef?: QuickBooksReference
}

export interface QuickBooksRefundReceipt extends QuickBooksSalesTransaction {
  readonly DepositToAccountRef?: QuickBooksReference
  readonly PaymentMethodRef?: QuickBooksReference
  readonly PaymentRefNum?: string
  readonly PaymentType?: string
  readonly CheckPayment?: {
    readonly CheckNum?: string
    readonly Status?: string
    readonly NameOnAcct?: string
    readonly AcctNum?: string
    readonly BankName?: string
  }
  readonly CreditCardPayment?: QuickBooksCreditCardPaymentInfo
  readonly TxnSource?: string
  readonly HomeBalance?: number
  readonly RecurDataRef?: QuickBooksReference
}

/** Accounting payment allocations can span invoices, credit memos, and other linked transactions. */
export type QuickBooksPaymentLine = QuickBooksLineBase

export interface QuickBooksPayment extends QuickBooksTransaction {
  readonly CustomerRef?: QuickBooksReference
  readonly ProjectRef?: QuickBooksReference
  readonly ARAccountRef?: QuickBooksReference
  readonly DepositToAccountRef?: QuickBooksReference
  readonly PaymentMethodRef?: QuickBooksReference
  readonly PaymentRefNum?: string
  readonly UnappliedAmt?: number
  readonly ProcessPayment?: boolean
  readonly Line?: readonly QuickBooksPaymentLine[]
}

interface QuickBooksPurchaseTransaction extends QuickBooksTransaction {
  readonly VendorRef?: QuickBooksReference
  readonly APAccountRef?: QuickBooksReference
  readonly Line?: readonly QuickBooksExpenseLine[]
  readonly TxnTaxDetail?: QuickBooksTaxDetail
  readonly GlobalTaxCalculation?: string
}

export interface QuickBooksBill extends QuickBooksPurchaseTransaction {
  readonly DueDate?: string
  readonly SalesTermRef?: QuickBooksReference
  readonly Balance?: number
  readonly HomeBalance?: number
  readonly VendorAddr?: QuickBooksAddress
  readonly RecurDataRef?: QuickBooksReference
}

export type QuickBooksVendorCredit = QuickBooksPurchaseTransaction

/** Expense, check or credit-card charge (or card credit when `Credit` is true). */
export interface QuickBooksPurchase extends QuickBooksTransaction {
  readonly PaymentType?: "Cash" | "Check" | "CreditCard" | (string & {})
  /** Bank or credit-card account the purchase was paid from. */
  readonly AccountRef?: QuickBooksReference
  /** Payee; `type` is Vendor, Customer or Employee. */
  readonly EntityRef?: QuickBooksReference
  readonly Credit?: boolean
  readonly RemitToAddr?: QuickBooksAddress
  readonly PrintStatus?: string
  readonly PaymentMethodRef?: QuickBooksReference
  readonly Line?: readonly QuickBooksExpenseLine[]
  readonly TxnTaxDetail?: QuickBooksTaxDetail
  readonly GlobalTaxCalculation?: string
  readonly TxnSource?: string
  readonly IncludeInAnnualTPAR?: boolean
  readonly RecurDataRef?: QuickBooksReference
  /** Opaque provider extension data, retained without interpretation. */
  readonly PurchaseEx?: Readonly<Record<string, unknown>>
}

export interface QuickBooksPurchaseOrder extends QuickBooksPurchaseTransaction {
  readonly POStatus?: "Open" | "Closed" | (string & {})
  readonly POEmail?: { readonly Address?: string }
  readonly VendorAddr?: QuickBooksAddress
  readonly ShipAddr?: QuickBooksAddress
  readonly ShipTo?: QuickBooksReference
  readonly ShipMethodRef?: QuickBooksReference
  readonly DueDate?: string
  readonly SalesTermRef?: QuickBooksReference
  readonly ClassRef?: QuickBooksReference
  readonly EmailStatus?: string
  readonly PrintStatus?: string
  readonly Memo?: string
  readonly RecurDataRef?: QuickBooksReference
}

export interface QuickBooksBillPayment extends QuickBooksTransaction {
  readonly VendorRef?: QuickBooksReference
  readonly VendorAddr?: QuickBooksAddress
  readonly APAccountRef?: QuickBooksReference
  readonly PayType?: "Check" | "CreditCard" | (string & {})
  readonly CheckPayment?: {
    readonly BankAccountRef?: QuickBooksReference
    readonly PrintStatus?: string
  }
  readonly CreditCardPayment?: { readonly CCAccountRef?: QuickBooksReference }
  readonly Line?: readonly QuickBooksPaymentLine[]
}

/** Time worked by an employee or vendor, optionally billable to a customer. */
export interface QuickBooksTimeActivity extends QuickBooksEntity {
  readonly TxnDate?: string
  readonly NameOf?: "Employee" | "Vendor" | (string & {})
  readonly EmployeeRef?: QuickBooksReference
  readonly VendorRef?: QuickBooksReference
  readonly CustomerRef?: QuickBooksReference
  readonly ProjectRef?: QuickBooksReference
  readonly ItemRef?: QuickBooksReference
  readonly ClassRef?: QuickBooksReference
  readonly DepartmentRef?: QuickBooksReference
  readonly PayrollItemRef?: QuickBooksReference
  readonly BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled" | (string & {})
  readonly Taxable?: boolean
  readonly HourlyRate?: number
  readonly CostRate?: number
  readonly Hours?: number
  readonly Minutes?: number
  readonly Seconds?: number
  readonly BreakHours?: number
  readonly BreakMinutes?: number
  readonly BreakSeconds?: number
  readonly StartTime?: string
  readonly EndTime?: string
  readonly Description?: string
  readonly TimeChargeId?: number
  readonly TransactionLocationType?: string
}

export interface QuickBooksDepositLine extends QuickBooksLineBase {
  /** Absent on lines that deposit a linked payment or sales receipt (see LinkedTxn). */
  readonly DetailType?: "DepositLineDetail"
  readonly DepositLineDetail?: {
    /** Received from; `type` is Customer, Vendor or Employee. */
    readonly Entity?: QuickBooksReference
    readonly AccountRef?: QuickBooksReference
    readonly ClassRef?: QuickBooksReference
    readonly PaymentMethodRef?: QuickBooksReference
    readonly CheckNum?: string
    readonly TxnType?: string
    readonly TaxCodeRef?: QuickBooksReference
    readonly TaxApplicableOn?: string
  }
}

export interface QuickBooksDeposit extends QuickBooksTransaction {
  readonly DepositToAccountRef?: QuickBooksReference
  readonly CashBack?: {
    readonly AccountRef?: QuickBooksReference
    readonly Amount?: number
    readonly Memo?: string
  }
  readonly Line?: readonly QuickBooksDepositLine[]
  readonly TxnTaxDetail?: QuickBooksTaxDetail
  readonly GlobalTaxCalculation?: string
  readonly TxnSource?: string
  readonly RecurDataRef?: QuickBooksReference
}

export interface QuickBooksTransfer extends QuickBooksTransaction {
  readonly FromAccountRef?: QuickBooksReference
  readonly ToAccountRef?: QuickBooksReference
  readonly Amount?: number
  readonly TransactionLocationType?: string
  readonly RecurDataRef?: QuickBooksReference
}

export interface QuickBooksJournalEntryLine extends QuickBooksLineBase {
  readonly DetailType?: "JournalEntryLineDetail" | "DescriptionOnly" | (string & {})
  readonly JournalEntryLineDetail?: {
    readonly PostingType?: "Debit" | "Credit"
    readonly AccountRef?: QuickBooksReference
    /** Name on the line, e.g. `{ Type: "Customer", EntityRef: { value: "9" } }`. */
    readonly Entity?: { readonly Type?: string; readonly EntityRef?: QuickBooksReference }
    readonly ClassRef?: QuickBooksReference
    readonly DepartmentRef?: QuickBooksReference
    readonly TaxCodeRef?: QuickBooksReference
    readonly TaxApplicableOn?: string
    readonly TaxAmount?: number
    readonly BillableStatus?: string
  }
}

export interface QuickBooksJournalEntry extends QuickBooksTransaction {
  readonly Adjustment?: boolean
  readonly Line?: readonly QuickBooksJournalEntryLine[]
  readonly TxnTaxDetail?: QuickBooksTaxDetail
  readonly GlobalTaxCalculation?: string
  readonly JournalCodeRef?: QuickBooksReference
  readonly RecurDataRef?: QuickBooksReference
}
