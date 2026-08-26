import type Stripe from "stripe"
import type { StripeListPromise, StripeRequestOptions, StripeResponse } from "../types"
import { assertCursorOptions, stripeId } from "../validation"

export type StripeRefund = Stripe.Refund
export type StripeRefundCreateParams = Stripe.RefundCreateParams
export type StripeRefundUpdateParams = Stripe.RefundUpdateParams
export type StripeRefundRetrieveParams = Stripe.RefundRetrieveParams
export type StripeRefundListParams = Stripe.RefundListParams
export type StripeRefundCancelParams = Stripe.RefundCancelParams

export interface RefundsResource {
  /** `POST /v1/refunds` — requires a Charge or PaymentIntent. */
  create(
    params: StripeRefundCreateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeRefund>>
  /** `POST /v1/refunds/{id}` — Stripe currently accepts metadata only. */
  update(
    id: string,
    params?: StripeRefundUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeRefund>>
  /** `GET /v1/refunds/{id}` */
  get(
    id: string,
    params?: StripeRefundRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeRefund>>
  /** `GET /v1/refunds` */
  list(
    params?: StripeRefundListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeRefund>
  /** Auto-paginated iterator over `GET /v1/refunds`. */
  listAll(
    params?: StripeRefundListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeRefund>
  /** `POST /v1/refunds/{id}/cancel` — only refunds in `requires_action`. */
  cancel(
    id: string,
    params?: StripeRefundCancelParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeRefund>>
}

export function createRefundsResource(sdk: Stripe): RefundsResource {
  return {
    create(params, options) {
      return sdk.refunds.create(params, options)
    },
    update(id, params, options) {
      return sdk.refunds.update(stripeId(id, "refund id"), params, options)
    },
    get(id, params, options) {
      return sdk.refunds.retrieve(stripeId(id, "refund id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.refunds.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.refunds.list(params, options)
    },
    cancel(id, params, options) {
      return sdk.refunds.cancel(stripeId(id, "refund id"), params, options)
    },
  }
}
