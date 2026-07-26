import type { AccountsResource } from "../resources/accounts"
import type { CategoriesResource } from "../resources/categories"
import type { CustomersResource } from "../resources/customers"
import type { EventsResource } from "../resources/events"
import type { InvoicesResource } from "../resources/invoices"
import type { MerchantsResource } from "../resources/merchants"
import type { OrganizationResource } from "../resources/organization"
import type { TransactionsResource } from "../resources/transactions"
import type { WebhookEndpointsResource } from "../resources/webhooks"

export interface MercuryClient {
  readonly accounts: AccountsResource
  readonly transactions: TransactionsResource
  /** The organization's custom expense categories. */
  readonly categories: CategoriesResource
  readonly merchants: MerchantsResource
  /** Accounts Receivable customers. */
  readonly customers: CustomersResource
  /** Accounts Receivable invoices. */
  readonly invoices: InvoicesResource
  readonly organization: OrganizationResource
  /** Mercury's audit stream, for polling changes without webhooks. */
  readonly events: EventsResource
  /** Registration and management of Mercury's outbound webhook endpoints. */
  readonly webhookEndpoints: WebhookEndpointsResource
}
