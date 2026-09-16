import type Stripe from "stripe"
import { type ChargesResource, createChargesResource } from "./resources/charges"
import { type CustomersResource, createCustomersResource } from "./resources/customers"
import { createEventsResource, type EventsResource } from "./resources/events"
import {
  createInvoicePaymentsResource,
  type InvoicePaymentsResource,
} from "./resources/invoice-payments"
import { createInvoicesResource, type InvoicesResource } from "./resources/invoices"
import {
  createPaymentIntentsResource,
  type PaymentIntentsResource,
} from "./resources/payment-intents"
import { createRefundsResource, type RefundsResource } from "./resources/refunds"
import { createSubscriptionsResource, type SubscriptionsResource } from "./resources/subscriptions"

export interface StripeClient {
  readonly customers: CustomersResource
  readonly subscriptions: SubscriptionsResource
  readonly invoices: InvoicesResource
  readonly invoicePayments: InvoicePaymentsResource
  readonly paymentIntents: PaymentIntentsResource
  readonly charges: ChargesResource
  readonly refunds: RefundsResource
  /** Snapshot events available from Stripe for 30 days. */
  readonly events: EventsResource
}

export function createStripeClient(sdk: Stripe): StripeClient {
  return {
    customers: createCustomersResource(sdk),
    subscriptions: createSubscriptionsResource(sdk),
    invoices: createInvoicesResource(sdk),
    invoicePayments: createInvoicePaymentsResource(sdk),
    paymentIntents: createPaymentIntentsResource(sdk),
    charges: createChargesResource(sdk),
    refunds: createRefundsResource(sdk),
    events: createEventsResource(sdk),
  }
}
