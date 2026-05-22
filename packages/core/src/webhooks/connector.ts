import type { ConnectorAdapter } from "../connectors/types"
import type { WebhookDefinition } from "./types"

export interface WebhookConnectorClient {
  readonly kind: "webhook"
}

/** Connector adapter for inbound-only integrations that expose no outbound client. */
export function webhookConnector(options: {
  readonly webhooks: readonly WebhookDefinition<unknown, WebhookConnectorClient>[]
}): ConnectorAdapter<"webhook", WebhookConnectorClient> {
  return {
    type: "webhook",
    webhooks: options.webhooks,
    connect() {
      return { kind: "webhook" }
    },
  }
}
