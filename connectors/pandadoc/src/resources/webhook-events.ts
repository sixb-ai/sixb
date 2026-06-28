import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocWebhookEventListOptions,
  PandaDocWebhookEventListResponse,
  PandaDocWebhookEventRecord,
} from "../types"

export interface WebhookEventsResource {
  /** `GET /public/v1/webhook-events` */
  list(options?: PandaDocWebhookEventListOptions): Promise<PandaDocWebhookEventListResponse>
  listAll(options?: PandaDocWebhookEventListOptions): AsyncIterable<PandaDocWebhookEventRecord>
  /** `GET /public/v1/webhook-events/{id}` */
  get(id: string): Promise<PandaDocWebhookEventRecord>
}

export function webhookEventsResource(http: PandaDocHttp): WebhookEventsResource {
  const resource: WebhookEventsResource = {
    list(options) {
      return http.get("public/v1/webhook-events", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.items, options)
    },
    get(id) {
      return http.get(`public/v1/webhook-events/${pathPart(id, "webhook event id")}`)
    },
  }

  return resource
}
