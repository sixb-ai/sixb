import type Stripe from "stripe"
import { type CustomersResource, createCustomersResource } from "./resources/customers"
import { createEventsResource, type EventsResource } from "./resources/events"
import { createInvoicesResource, type InvoicesResource } from "./resources/invoices"
import { createRefundsResource, type RefundsResource } from "./resources/refunds"
import { createSubscriptionsResource, type SubscriptionsResource } from "./resources/subscriptions"

export interface StripeClient {
  readonly customers: CustomersResource
  readonly subscriptions: SubscriptionsResource
  readonly invoices: InvoicesResource
  readonly refunds: RefundsResource
  /** Snapshot events available from Stripe for 30 days. */
  readonly events: EventsResource
}

export function createStripeClient(sdk: Stripe): StripeClient {
  return {
    customers: createCustomersResource(sdk),
    subscriptions: createSubscriptionsResource(sdk),
    invoices: createInvoicesResource(sdk),
    refunds: createRefundsResource(sdk),
    events: createEventsResource(sdk),
  }
}
