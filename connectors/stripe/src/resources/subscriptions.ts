import type Stripe from "stripe"
import type {
  StripeListPromise,
  StripeRequestOptions,
  StripeResponse,
  StripeSearchPromise,
} from "../types"
import { assertCursorOptions, assertPageLimit, stripeId } from "../validation"

export type StripeSubscription = Stripe.Subscription
export type StripeSubscriptionCreateParams = Stripe.SubscriptionCreateParams
export type StripeSubscriptionUpdateParams = Stripe.SubscriptionUpdateParams
export type StripeSubscriptionRetrieveParams = Stripe.SubscriptionRetrieveParams
export type StripeSubscriptionListParams = Stripe.SubscriptionListParams
export type StripeSubscriptionCancelParams = Stripe.SubscriptionCancelParams
export type StripeSubscriptionSearchParams = Stripe.SubscriptionSearchParams
export type StripeSubscriptionMigrateParams = Stripe.SubscriptionMigrateParams
export type StripeSubscriptionResumeParams = Stripe.SubscriptionResumeParams

export interface SubscriptionsResource {
  /** `POST /v1/subscriptions` */
  create(
    params: StripeSubscriptionCreateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `POST /v1/subscriptions/{id}` */
  update(
    id: string,
    params?: StripeSubscriptionUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `GET /v1/subscriptions/{id}` */
  get(
    id: string,
    params?: StripeSubscriptionRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `GET /v1/subscriptions` */
  list(
    params?: StripeSubscriptionListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeSubscription>
  /** Auto-paginated iterator over `GET /v1/subscriptions`. */
  listAll(
    params?: StripeSubscriptionListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeSubscription>
  /** `DELETE /v1/subscriptions/{id}` — immediate cancellation. */
  cancel(
    id: string,
    params?: StripeSubscriptionCancelParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `POST /v1/subscriptions/{id}/migrate` — upgrades the subscription billing mode. */
  migrate(
    id: string,
    params: StripeSubscriptionMigrateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `POST /v1/subscriptions/{id}/resume` */
  resume(
    id: string,
    params?: StripeSubscriptionResumeParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeSubscription>>
  /** `GET /v1/subscriptions/search` — eventually consistent and unavailable in India. */
  search(
    params: StripeSubscriptionSearchParams,
    options?: StripeRequestOptions
  ): StripeSearchPromise<StripeSubscription>
  /** Auto-paginated iterator over `GET /v1/subscriptions/search`. */
  searchAll(
    params: StripeSubscriptionSearchParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeSubscription>
}

export function createSubscriptionsResource(sdk: Stripe): SubscriptionsResource {
  return {
    create(params, options) {
      return sdk.subscriptions.create(params, options)
    },
    update(id, params, options) {
      return sdk.subscriptions.update(stripeId(id, "subscription id"), params, options)
    },
    get(id, params, options) {
      return sdk.subscriptions.retrieve(stripeId(id, "subscription id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.subscriptions.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.subscriptions.list(params, options)
    },
    cancel(id, params, options) {
      return sdk.subscriptions.cancel(stripeId(id, "subscription id"), params, options)
    },
    migrate(id, params, options) {
      return sdk.subscriptions.migrate(stripeId(id, "subscription id"), params, options)
    },
    resume(id, params, options) {
      return sdk.subscriptions.resume(stripeId(id, "subscription id"), params, options)
    },
    search(params, options) {
      assertPageLimit(params.limit)
      return sdk.subscriptions.search(params, options)
    },
    searchAll(params, options) {
      assertPageLimit(params.limit)
      return sdk.subscriptions.search(params, options)
    },
  }
}
