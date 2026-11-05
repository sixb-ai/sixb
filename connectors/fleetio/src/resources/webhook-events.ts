import type { FleetioHttp } from "../http"
import type {
  FleetioWebhookEvent,
  FleetioWebhookEventFilter,
  FleetioWebhookEventSort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

/** Delivery history, kept for 30 days. Useful for catching up after an outage. */
export type WebhookEventsResource = FleetioReadMethods<
  FleetioWebhookEvent,
  FleetioWebhookEvent,
  FleetioWebhookEventFilter,
  FleetioWebhookEventSort
>

export function webhookEventsResource(http: FleetioHttp): WebhookEventsResource {
  return readMethods(http, "webhook_events", "webhook event id")
}
