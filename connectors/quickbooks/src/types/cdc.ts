import type { QuickBooksAttachment } from "./attachments"
import type {
  QuickBooksAccount,
  QuickBooksBudget,
  QuickBooksClass,
  QuickBooksCompanyCurrency,
  QuickBooksCustomer,
  QuickBooksCustomerType,
  QuickBooksDepartment,
  QuickBooksEmployee,
  QuickBooksItem,
  QuickBooksPaymentMethod,
  QuickBooksTerm,
  QuickBooksVendor,
} from "./entities"
import type { QuickBooksTaxCode, QuickBooksTaxRate } from "./tax"
import type {
  QuickBooksBill,
  QuickBooksBillPayment,
  QuickBooksCreditCardPayment,
  QuickBooksCreditMemo,
  QuickBooksDeposit,
  QuickBooksEstimate,
  QuickBooksInventoryAdjustment,
  QuickBooksInvoice,
  QuickBooksJournalEntry,
  QuickBooksPayment,
  QuickBooksPurchase,
  QuickBooksPurchaseOrder,
  QuickBooksRecurringInfo,
  QuickBooksRecurringTemplateMap,
  QuickBooksRecurringTemplateType,
  QuickBooksRecurringTransaction,
  QuickBooksRefundReceipt,
  QuickBooksReimburseCharge,
  QuickBooksSalesReceipt,
  QuickBooksTimeActivity,
  QuickBooksTransfer,
  QuickBooksVendorCredit,
} from "./transactions"

/** Entities QuickBooks accepts in CDC requests (verified in the sandbox). */
export interface QuickBooksCdcEntityMap {
  readonly Account: QuickBooksAccount
  readonly Attachable: QuickBooksAttachment
  readonly Budget: QuickBooksBudget
  readonly Class: QuickBooksClass
  readonly CompanyCurrency: QuickBooksCompanyCurrency
  readonly Customer: QuickBooksCustomer
  readonly CustomerType: QuickBooksCustomerType
  readonly Department: QuickBooksDepartment
  readonly Employee: QuickBooksEmployee
  readonly Item: QuickBooksItem
  readonly PaymentMethod: QuickBooksPaymentMethod
  readonly TaxCode: QuickBooksTaxCode
  readonly TaxRate: QuickBooksTaxRate
  readonly Term: QuickBooksTerm
  readonly Vendor: QuickBooksVendor
  readonly Bill: QuickBooksBill
  readonly BillPayment: QuickBooksBillPayment
  /** Card payments; QuickBooks names both the CDC entity and its group CreditCardPaymentTxn. */
  readonly CreditCardPaymentTxn: QuickBooksCreditCardPayment
  readonly CreditMemo: QuickBooksCreditMemo
  readonly Deposit: QuickBooksDeposit
  readonly Estimate: QuickBooksEstimate
  readonly InventoryAdjustment: QuickBooksInventoryAdjustment
  readonly Invoice: QuickBooksInvoice
  readonly JournalEntry: QuickBooksJournalEntry
  readonly Payment: QuickBooksPayment
  readonly Purchase: QuickBooksPurchase
  readonly PurchaseOrder: QuickBooksPurchaseOrder
  readonly RecurringTransaction: QuickBooksRecurringTransaction
  readonly RefundReceipt: QuickBooksRefundReceipt
  readonly ReimburseCharge: QuickBooksReimburseCharge
  readonly SalesReceipt: QuickBooksSalesReceipt
  readonly TimeActivity: QuickBooksTimeActivity
  readonly Transfer: QuickBooksTransfer
  readonly VendorCredit: QuickBooksVendorCredit
}

export type QuickBooksCdcEntity = keyof QuickBooksCdcEntityMap

export interface QuickBooksDeletedEntity {
  readonly Id: string
  readonly status: "Deleted"
  readonly domain?: string
  readonly MetaData?: { readonly LastUpdatedTime?: string }
}

export type QuickBooksCdcChange<T> = (T & { readonly status?: never }) | QuickBooksDeletedEntity

/** Recurring changes keep the template wrapper, including deletions: `{ Bill: { Id, status } }`. */
export type QuickBooksRecurringTransactionChange = {
  [K in QuickBooksRecurringTemplateType]: {
    readonly [P in K]: QuickBooksCdcChange<
      QuickBooksRecurringTemplateMap[K] & { readonly RecurringInfo?: QuickBooksRecurringInfo }
    >
  }
}[QuickBooksRecurringTemplateType]

export type QuickBooksCdcEntityChange<K extends QuickBooksCdcEntity> =
  K extends "RecurringTransaction"
    ? QuickBooksRecurringTransactionChange
    : QuickBooksCdcChange<QuickBooksCdcEntityMap[K]>

export type QuickBooksCdcQueryResponse = {
  readonly [K in QuickBooksCdcEntity]?: readonly QuickBooksCdcEntityChange<K>[]
} & {
  readonly startPosition?: number
  readonly maxResults?: number
  readonly totalCount?: number
}

export interface QuickBooksCdcResponse {
  readonly CDCResponse: readonly { readonly QueryResponse: readonly QuickBooksCdcQueryResponse[] }[]
  readonly time: string
}

export interface QuickBooksCdcOptions {
  readonly entities: readonly QuickBooksCdcEntity[]
  /** Must be in the past and no more than 30 days old. */
  readonly changedSince: Date
}
