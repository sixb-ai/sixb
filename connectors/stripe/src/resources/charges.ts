import type Stripe from "stripe"
import type {
  StripeListPromise,
  StripeRequestOptions,
  StripeResponse,
  StripeSearchPromise,
} from "../types"
import { assertCursorOptions, assertPageLimit, stripeId } from "../validation"

export type StripeCharge = Stripe.Charge
export type StripeChargeRetrieveParams = Stripe.ChargeRetrieveParams
export type StripeChargeUpdateParams = Stripe.ChargeUpdateParams
export type StripeChargeListParams = Stripe.ChargeListParams
export type StripeChargeSearchParams = Stripe.ChargeSearchParams

export interface ChargesResource {
  /** `GET /v1/charges/{id}` */
  get(
    id: string,
    params?: StripeChargeRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeCharge>>
  /** `POST /v1/charges/{id}` — updating receipt_email sends a new receipt. */
  update(
    id: string,
    params?: StripeChargeUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeCharge>>
  /** `GET /v1/charges` */
  list(
    params?: StripeChargeListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeCharge>
  /** Auto-paginated iterator over `GET /v1/charges`. */
  listAll(
    params?: StripeChargeListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeCharge>
  /** `GET /v1/charges/search` — eventually consistent and unavailable in India. */
  search(
    params: StripeChargeSearchParams,
    options?: StripeRequestOptions
  ): StripeSearchPromise<StripeCharge>
  /** Auto-paginated iterator over `GET /v1/charges/search`. */
  searchAll(
    params: StripeChargeSearchParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeCharge>
}

export function createChargesResource(sdk: Stripe): ChargesResource {
  return {
    get(id, params, options) {
      return sdk.charges.retrieve(stripeId(id, "charge id"), params, options)
    },
    update(id, params, options) {
      return sdk.charges.update(stripeId(id, "charge id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.charges.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.charges.list(params, options)
    },
    search(params, options) {
      assertPageLimit(params.limit)
      return sdk.charges.search(params, options)
    },
    searchAll(params, options) {
      assertPageLimit(params.limit)
      return sdk.charges.search(params, options)
    },
  }
}
