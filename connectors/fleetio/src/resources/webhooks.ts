import type { FleetioHttp } from "../http"
import type {
  FleetioWebhook,
  FleetioWebhookCreateInput,
  FleetioWebhookFilter,
  FleetioWebhookSort,
  FleetioWebhookUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

/**
 * Fleetio's outbound webhook endpoints. The response's `shared_key` is the secret to pass as
 * `webhookSecret`, and `disabled_at` shows when Fleetio turned the webhook off after failures.
 */
export type WebhooksResource = FleetioReadMethods<
  FleetioWebhook,
  FleetioWebhook,
  FleetioWebhookFilter,
  FleetioWebhookSort
> &
  FleetioWriteMethods<
    FleetioWebhookCreateInput,
    FleetioWebhook,
    FleetioWebhookUpdateInput,
    FleetioWebhook
  >

export function webhooksResource(http: FleetioHttp): WebhooksResource {
  return {
    ...readMethods(http, "webhooks", "webhook id"),
    ...writeMethods(http, "webhooks", "webhook id"),
  }
}
