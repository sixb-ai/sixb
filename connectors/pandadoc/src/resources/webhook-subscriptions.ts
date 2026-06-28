import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocWebhookSubscription,
  PandaDocWebhookSubscriptionInput,
  PandaDocWebhookSubscriptionListOptions,
  PandaDocWebhookSubscriptionListResponse,
  PandaDocWebhookSubscriptionUpdateInput,
} from "../types"

export interface WebhookSubscriptionsResource {
  /** `GET /public/v1/webhook-subscriptions` */
  list(
    options?: PandaDocWebhookSubscriptionListOptions
  ): Promise<PandaDocWebhookSubscriptionListResponse>
  listAll(
    options?: PandaDocWebhookSubscriptionListOptions
  ): AsyncIterable<PandaDocWebhookSubscription>
  /** `POST /public/v1/webhook-subscriptions` */
  create(input: PandaDocWebhookSubscriptionInput): Promise<PandaDocWebhookSubscription>
  /** `GET /public/v1/webhook-subscriptions/{id}` */
  get(id: string): Promise<PandaDocWebhookSubscription>
  /** `PATCH /public/v1/webhook-subscriptions/{id}` */
  update(
    id: string,
    input: PandaDocWebhookSubscriptionUpdateInput
  ): Promise<PandaDocWebhookSubscription>
  /** `PATCH /public/v1/webhook-subscriptions/{id}/shared-key` */
  updateSharedKey(id: string): Promise<PandaDocWebhookSubscription>
  /** `DELETE /public/v1/webhook-subscriptions/{id}` */
  delete(id: string): Promise<void>
}

export function webhookSubscriptionsResource(http: PandaDocHttp): WebhookSubscriptionsResource {
  const resource: WebhookSubscriptionsResource = {
    list(options) {
      return http.get("public/v1/webhook-subscriptions", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.items, options)
    },
    create(input) {
      return http.post("public/v1/webhook-subscriptions", input)
    },
    get(id) {
      return http.get(`public/v1/webhook-subscriptions/${pathPart(id, "webhook subscription id")}`)
    },
    update(id, input) {
      return http.patch(
        `public/v1/webhook-subscriptions/${pathPart(id, "webhook subscription id")}`,
        input
      )
    },
    updateSharedKey(id) {
      return http.patch(
        `public/v1/webhook-subscriptions/${pathPart(id, "webhook subscription id")}/shared-key`
      )
    },
    delete(id) {
      return http.delete(
        `public/v1/webhook-subscriptions/${pathPart(id, "webhook subscription id")}`
      )
    },
  }

  return resource
}
