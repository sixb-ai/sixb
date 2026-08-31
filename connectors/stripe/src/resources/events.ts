import type Stripe from "stripe"
import type { StripeListPromise, StripeRequestOptions, StripeResponse } from "../types"
import { assertCursorOptions, stripeId } from "../validation"

export type StripeEvent = Stripe.Event
export type StripeEventRetrieveParams = Stripe.EventRetrieveParams
export type StripeEventListParams = Stripe.EventListParams

export interface EventsResource {
  /** `GET /v1/events/{id}` — Stripe guarantees retrieval for 30 days. */
  get(
    id: string,
    params?: StripeEventRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeEvent>>
  /** `GET /v1/events` — Stripe exposes up to 30 days of events. */
  list(
    params?: StripeEventListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeEvent>
  /** Auto-paginated iterator over `GET /v1/events`. */
  listAll(
    params?: StripeEventListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeEvent>
}

export function createEventsResource(sdk: Stripe): EventsResource {
  return {
    get(id, params, options) {
      return sdk.events.retrieve(stripeId(id, "event id"), params, options)
    },
    list(params, options) {
      assertEventListParams(params)
      return sdk.events.list(params, options)
    },
    listAll(params, options) {
      assertEventListParams(params)
      return sdk.events.list(params, options)
    },
  }
}

function assertEventListParams(params: StripeEventListParams | undefined): void {
  assertCursorOptions(params)
  if (params?.type && params.types?.length) {
    throw new Error("[SixbStripe] events.list accepts type or types, but not both.")
  }
  if (params?.types && params.types.length > 20) {
    throw new Error("[SixbStripe] events.list accepts at most 20 event types.")
  }
}
