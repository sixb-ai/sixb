import type Stripe from "stripe"
import type {
  StripeListPromise,
  StripeRequestOptions,
  StripeResponse,
  StripeSearchPromise,
} from "../types"
import { assertCursorOptions, assertPageLimit, stripeId } from "../validation"

export type StripeCustomer = Stripe.Customer
export type StripeDeletedCustomer = Stripe.DeletedCustomer
export type StripeCustomerCreateParams = Stripe.CustomerCreateParams
export type StripeCustomerUpdateParams = Stripe.CustomerUpdateParams
export type StripeCustomerRetrieveParams = Stripe.CustomerRetrieveParams
export type StripeCustomerListParams = Stripe.CustomerListParams
export type StripeCustomerDeleteParams = Stripe.CustomerDeleteParams
export type StripeCustomerSearchParams = Stripe.CustomerSearchParams

export interface CustomersResource {
  /** `POST /v1/customers` */
  create(
    params?: StripeCustomerCreateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeCustomer>>
  /** `POST /v1/customers/{id}` */
  update(
    id: string,
    params?: StripeCustomerUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeCustomer>>
  /** `GET /v1/customers/{id}` */
  get(
    id: string,
    params?: StripeCustomerRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeCustomer | StripeDeletedCustomer>>
  /** `GET /v1/customers` */
  list(
    params?: StripeCustomerListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeCustomer>
  /** Auto-paginated iterator over `GET /v1/customers`. */
  listAll(
    params?: StripeCustomerListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeCustomer>
  /** `DELETE /v1/customers/{id}` — permanent and also cancels active subscriptions. */
  delete(
    id: string,
    params?: StripeCustomerDeleteParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeDeletedCustomer>>
  /** `GET /v1/customers/search` — eventually consistent and unavailable in India. */
  search(
    params: StripeCustomerSearchParams,
    options?: StripeRequestOptions
  ): StripeSearchPromise<StripeCustomer>
  /** Auto-paginated iterator over `GET /v1/customers/search`. */
  searchAll(
    params: StripeCustomerSearchParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeCustomer>
}

export function createCustomersResource(sdk: Stripe): CustomersResource {
  return {
    create(params, options) {
      return sdk.customers.create(params, options)
    },
    update(id, params, options) {
      return sdk.customers.update(stripeId(id, "customer id"), params, options)
    },
    get(id, params, options) {
      return sdk.customers.retrieve(stripeId(id, "customer id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.customers.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.customers.list(params, options)
    },
    delete(id, params, options) {
      return sdk.customers.del(stripeId(id, "customer id"), params, options)
    },
    search(params, options) {
      assertPageLimit(params.limit)
      return sdk.customers.search(params, options)
    },
    searchAll(params, options) {
      assertPageLimit(params.limit)
      return sdk.customers.search(params, options)
    },
  }
}
