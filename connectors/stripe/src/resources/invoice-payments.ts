import type Stripe from "stripe"
import type { StripeListPromise, StripeRequestOptions, StripeResponse } from "../types"
import { assertCursorOptions, stripeId } from "../validation"

export type StripeInvoicePayment = Stripe.InvoicePayment
export type StripeInvoicePaymentRetrieveParams = Stripe.InvoicePaymentRetrieveParams
export type StripeInvoicePaymentListParams = Stripe.InvoicePaymentListParams

export interface InvoicePaymentsResource {
  /** `GET /v1/invoice_payments/{id}` */
  get(
    id: string,
    params?: StripeInvoicePaymentRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoicePayment>>
  /** `GET /v1/invoice_payments` — optionally filtered by invoice or payment. */
  list(
    params?: StripeInvoicePaymentListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeInvoicePayment>
  /** Auto-paginated iterator over `GET /v1/invoice_payments`. */
  listAll(
    params?: StripeInvoicePaymentListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeInvoicePayment>
}

export function createInvoicePaymentsResource(sdk: Stripe): InvoicePaymentsResource {
  return {
    get(id, params, options) {
      return sdk.invoicePayments.retrieve(stripeId(id, "invoice payment id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.invoicePayments.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.invoicePayments.list(params, options)
    },
  }
}
