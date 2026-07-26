import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryCreateWebhookInput,
  MercuryUpdateWebhookInput,
  MercuryVerifyWebhookInput,
  MercuryWebhookEndpoint,
  MercuryWebhookListOptions,
  MercuryWebhooksResponse,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

/**
 * Manages the webhook endpoints Mercury delivers events to. This is the outbound registration
 * side; the inbound route is registered by passing `onEvent` to the connector.
 */
export interface WebhookEndpointsResource {
  /** `GET /webhooks` */
  list(options?: MercuryWebhookListOptions): Promise<MercuryWebhooksResponse>
  /** Cursor iterator over `GET /webhooks`. */
  listAll(options?: MercuryWebhookListOptions): AsyncIterable<MercuryWebhookEndpoint>
  /** `GET /webhooks/{webhookEndpointId}` */
  get(webhookEndpointId: string): Promise<MercuryWebhookEndpoint>
  /** `POST /webhooks` — the only response that carries `secret`. Store it now. */
  create(input: MercuryCreateWebhookInput): Promise<MercuryWebhookEndpoint>
  /** `POST /webhooks/{webhookEndpointId}` — also reactivates a `disabled` endpoint. */
  update(
    webhookEndpointId: string,
    input: MercuryUpdateWebhookInput
  ): Promise<MercuryWebhookEndpoint>
  /** `POST /webhooks/{webhookEndpointId}/verify` — sends a test delivery. */
  verify(webhookEndpointId: string, input?: MercuryVerifyWebhookInput): Promise<void>
  /** `DELETE /webhooks/{webhookEndpointId}` */
  delete(webhookEndpointId: string): Promise<void>
}

export function createWebhookEndpointsResource(http: MercuryHttp): WebhookEndpointsResource {
  const resource: WebhookEndpointsResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("webhooks", { ...cursorQuery(options), status: options?.status })
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.webhooks, options)
    },
    get(webhookEndpointId) {
      return http.get(`webhooks/${pathId(webhookEndpointId, "webhook endpoint id")}`)
    },
    create(input) {
      return http.post("webhooks", input)
    },
    update(webhookEndpointId, input) {
      return http.post(`webhooks/${pathId(webhookEndpointId, "webhook endpoint id")}`, input)
    },
    verify(webhookEndpointId, input) {
      return http.post(
        `webhooks/${pathId(webhookEndpointId, "webhook endpoint id")}/verify`,
        input ?? {}
      )
    },
    delete(webhookEndpointId) {
      return http.delete(`webhooks/${pathId(webhookEndpointId, "webhook endpoint id")}`)
    },
  }

  return resource
}
