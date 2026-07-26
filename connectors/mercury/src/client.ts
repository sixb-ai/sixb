import type { MercuryHttp } from "./http"
import { createAccountsResource } from "./resources/accounts"
import { createCategoriesResource } from "./resources/categories"
import { createCustomersResource } from "./resources/customers"
import { createEventsResource } from "./resources/events"
import { createInvoicesResource } from "./resources/invoices"
import { createMerchantsResource } from "./resources/merchants"
import { createOrganizationResource } from "./resources/organization"
import { createTransactionsResource } from "./resources/transactions"
import { createWebhookEndpointsResource } from "./resources/webhooks"
import type { MercuryClient } from "./types"

export function createMercuryClient(http: MercuryHttp): MercuryClient {
  return {
    accounts: createAccountsResource(http),
    transactions: createTransactionsResource(http),
    categories: createCategoriesResource(http),
    merchants: createMerchantsResource(http),
    customers: createCustomersResource(http),
    invoices: createInvoicesResource(http),
    organization: createOrganizationResource(http),
    events: createEventsResource(http),
    webhookEndpoints: createWebhookEndpointsResource(http),
  }
}
