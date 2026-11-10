import { type QuickBooksReadHttp, transactionReader } from "../query"
import type {
  QuickBooksCreditCardPaymentListOptions,
  QuickBooksInventoryAdjustmentListOptions,
  QuickBooksReadResource,
  QuickBooksReimburseChargeListOptions,
  QuickBooksTaxPaymentListOptions,
} from "../types/query"
import type { QuickBooksTaxPayment } from "../types/tax"
import type {
  QuickBooksCreditCardPayment,
  QuickBooksInventoryAdjustment,
  QuickBooksReimburseCharge,
} from "../types/transactions"

/** Billable expenses; QuickBooks accepts no TxnDate or DocNumber predicates for them. */
export type QuickBooksReimburseChargesResource = QuickBooksReadResource<
  QuickBooksReimburseCharge,
  QuickBooksReimburseChargeListOptions
>
/** The wire entity is CreditCardPaymentTxn (path creditcardpayment). */
export type QuickBooksCreditCardPaymentsResource = QuickBooksReadResource<
  QuickBooksCreditCardPayment,
  QuickBooksCreditCardPaymentListOptions
>
export type QuickBooksInventoryAdjustmentsResource = QuickBooksReadResource<
  QuickBooksInventoryAdjustment,
  QuickBooksInventoryAdjustmentListOptions
>
/** Not available in US companies (QuickBooks error 5030). */
export type QuickBooksTaxPaymentsResource = QuickBooksReadResource<
  QuickBooksTaxPayment,
  QuickBooksTaxPaymentListOptions
>

export function createReimburseChargesResource(http: QuickBooksReadHttp) {
  return transactionReader<QuickBooksReimburseCharge, QuickBooksReimburseChargeListOptions>(
    http,
    "ReimburseCharge",
    "reimbursecharge",
    { party: "customer", txnDate: false, docNumber: false }
  )
}

export function createCreditCardPaymentsResource(http: QuickBooksReadHttp) {
  return transactionReader<QuickBooksCreditCardPayment, QuickBooksCreditCardPaymentListOptions>(
    http,
    "CreditCardPayment",
    "creditcardpayment",
    { docNumber: false },
    "CreditCardPaymentTxn"
  )
}

export function createInventoryAdjustmentsResource(http: QuickBooksReadHttp) {
  return transactionReader<QuickBooksInventoryAdjustment, QuickBooksInventoryAdjustmentListOptions>(
    http,
    "InventoryAdjustment",
    "inventoryadjustment"
  )
}

export function createTaxPaymentsResource(http: QuickBooksReadHttp) {
  return transactionReader<QuickBooksTaxPayment, QuickBooksTaxPaymentListOptions>(
    http,
    "TaxPayment",
    "taxpayment",
    { txnDate: false, docNumber: false }
  )
}
