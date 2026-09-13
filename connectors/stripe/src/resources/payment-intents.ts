import type Stripe from "stripe"
import type {
  StripeListPromise,
  StripeRequestOptions,
  StripeResponse,
  StripeSearchPromise,
} from "../types"
import { assertCursorOptions, assertPageLimit, stripeId } from "../validation"

export type StripePaymentIntent = Stripe.PaymentIntent
export type StripePaymentIntentAmountDetailsLineItem = Stripe.PaymentIntentAmountDetailsLineItem
export type StripePaymentIntentCreateParams = Stripe.PaymentIntentCreateParams
export type StripePaymentIntentUpdateParams = Stripe.PaymentIntentUpdateParams
export type StripePaymentIntentRetrieveParams = Stripe.PaymentIntentRetrieveParams
export type StripePaymentIntentListParams = Stripe.PaymentIntentListParams
export type StripePaymentIntentCancelParams = Stripe.PaymentIntentCancelParams
export type StripePaymentIntentCaptureParams = Stripe.PaymentIntentCaptureParams
export type StripePaymentIntentConfirmParams = Stripe.PaymentIntentConfirmParams
export type StripePaymentIntentIncrementAuthorizationParams =
  Stripe.PaymentIntentIncrementAuthorizationParams
export type StripePaymentIntentApplyCustomerBalanceParams =
  Stripe.PaymentIntentApplyCustomerBalanceParams
export type StripePaymentIntentVerifyMicrodepositsParams =
  Stripe.PaymentIntentVerifyMicrodepositsParams
export type StripePaymentIntentSearchParams = Stripe.PaymentIntentSearchParams
export type StripePaymentIntentListAmountDetailsLineItemsParams =
  Stripe.PaymentIntentListAmountDetailsLineItemsParams

export interface PaymentIntentsResource {
  /** POST /v1/payment_intents */
  create(
    params: StripePaymentIntentCreateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id} */
  update(
    id: string,
    params?: StripePaymentIntentUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** GET /v1/payment_intents/{id} */
  get(
    id: string,
    params?: StripePaymentIntentRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** GET /v1/payment_intents */
  list(
    params?: StripePaymentIntentListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripePaymentIntent>
  /** Auto-paginated iterator over GET /v1/payment_intents. */
  listAll(
    params?: StripePaymentIntentListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripePaymentIntent>
  /** POST /v1/payment_intents/{id}/cancel */
  cancel(
    id: string,
    params?: StripePaymentIntentCancelParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id}/capture — requires_capture payments only. */
  capture(
    id: string,
    params?: StripePaymentIntentCaptureParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id}/confirm — may return requires_action. */
  confirm(
    id: string,
    params?: StripePaymentIntentConfirmParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id}/increment_authorization */
  incrementAuthorization(
    id: string,
    params: StripePaymentIntentIncrementAuthorizationParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id}/apply_customer_balance */
  applyCustomerBalance(
    id: string,
    params?: StripePaymentIntentApplyCustomerBalanceParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** POST /v1/payment_intents/{id}/verify_microdeposits */
  verifyMicrodeposits(
    id: string,
    params?: StripePaymentIntentVerifyMicrodepositsParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripePaymentIntent>>
  /** GET /v1/payment_intents/search — eventually consistent and unavailable in India. */
  search(
    params: StripePaymentIntentSearchParams,
    options?: StripeRequestOptions
  ): StripeSearchPromise<StripePaymentIntent>
  /** Auto-paginated iterator over GET /v1/payment_intents/search. */
  searchAll(
    params: StripePaymentIntentSearchParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripePaymentIntent>
  /** GET /v1/payment_intents/{id}/amount_details_line_items */
  listAmountDetailsLineItems(
    id: string,
    params?: StripePaymentIntentListAmountDetailsLineItemsParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripePaymentIntentAmountDetailsLineItem>
  /** Auto-paginated iterator over the amount details line items. */
  listAllAmountDetailsLineItems(
    id: string,
    params?: StripePaymentIntentListAmountDetailsLineItemsParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripePaymentIntentAmountDetailsLineItem>
}

export function createPaymentIntentsResource(sdk: Stripe): PaymentIntentsResource {
  return {
    create(params, options) {
      return sdk.paymentIntents.create(params, options)
    },
    update(id, params, options) {
      return sdk.paymentIntents.update(stripeId(id, "payment intent id"), params, options)
    },
    get(id, params, options) {
      return sdk.paymentIntents.retrieve(stripeId(id, "payment intent id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.paymentIntents.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.paymentIntents.list(params, options)
    },
    cancel(id, params, options) {
      return sdk.paymentIntents.cancel(stripeId(id, "payment intent id"), params, options)
    },
    capture(id, params, options) {
      return sdk.paymentIntents.capture(stripeId(id, "payment intent id"), params, options)
    },
    confirm(id, params, options) {
      return sdk.paymentIntents.confirm(stripeId(id, "payment intent id"), params, options)
    },
    incrementAuthorization(id, params, options) {
      return sdk.paymentIntents.incrementAuthorization(
        stripeId(id, "payment intent id"),
        params,
        options
      )
    },
    applyCustomerBalance(id, params, options) {
      return sdk.paymentIntents.applyCustomerBalance(
        stripeId(id, "payment intent id"),
        params,
        options
      )
    },
    verifyMicrodeposits(id, params, options) {
      return sdk.paymentIntents.verifyMicrodeposits(
        stripeId(id, "payment intent id"),
        params,
        options
      )
    },
    search(params, options) {
      assertPageLimit(params.limit)
      return sdk.paymentIntents.search(params, options)
    },
    searchAll(params, options) {
      assertPageLimit(params.limit)
      return sdk.paymentIntents.search(params, options)
    },
    listAmountDetailsLineItems(id, params, options) {
      assertCursorOptions(params)
      return sdk.paymentIntents.listAmountDetailsLineItems(
        stripeId(id, "payment intent id"),
        params,
        options
      )
    },
    listAllAmountDetailsLineItems(id, params, options) {
      assertCursorOptions(params)
      return sdk.paymentIntents.listAmountDetailsLineItems(
        stripeId(id, "payment intent id"),
        params,
        options
      )
    },
  }
}
