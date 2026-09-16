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

export interface QuickBooksCreditMemo extends QuickBooksSalesTransaction {
  readonly RemainingCredit?: number
  readonly PaymentMethodRef?: QuickBooksReference
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
