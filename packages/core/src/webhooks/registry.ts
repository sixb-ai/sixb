import type { ConnectorDefinition } from "../connectors/types"
import { WebhookValidationError } from "./errors"
import type { RegisteredWebhook, WebhookDefinition } from "./types"

/** Read-only access to connector webhooks registered by a host. */
export interface WebhookCatalog {
  list(): readonly RegisteredWebhook[]
  getByRoute(route: string): RegisteredWebhook | null
  getById(connectorId: string, webhookId: string): RegisteredWebhook | null
}

export interface WebhookRegistryOptions {
  readonly connectors: readonly ConnectorDefinition[]
}

export class WebhookRegistry implements WebhookCatalog {
  private readonly webhooks: readonly RegisteredWebhook[]
  private readonly byRoute = new Map<string, RegisteredWebhook>()

  constructor(options: WebhookRegistryOptions) {
    const registered: RegisteredWebhook[] = []

    for (const connector of options.connectors) {
      const webhooks = connector.adapter.webhooks ?? []
      if (!Array.isArray(webhooks)) {
        throw new WebhookValidationError(
          `[Sixb] Connector '${connector.id}' webhooks must be an array when provided.`
        )
      }

      const ids = new Set<string>()
      for (const webhook of webhooks) {
        assertValidWebhook(connector.id, webhook)

        if (ids.has(webhook.id)) {
          throw new WebhookValidationError(
            `[Sixb] Duplicate webhook id '${webhook.id}' for connector '${connector.id}'.`
          )
        }
        ids.add(webhook.id)

        const route = webhookRoute(connector.id, webhook.id)
        const duplicate = this.byRoute.get(route)
        if (duplicate) {
          throw new WebhookValidationError(
            `[Sixb] Duplicate webhook route '${route}' for connectors '${duplicate.connector.id}' and '${connector.id}'.`
          )
        }

        const registeredWebhook = {
          connector,
          webhook,
          route,
        } satisfies RegisteredWebhook

        this.byRoute.set(route, registeredWebhook)
        registered.push(registeredWebhook)
      }
    }

    this.webhooks = Object.freeze(registered)
  }

  list(): readonly RegisteredWebhook[] {
    return this.webhooks
  }

  getByRoute(route: string): RegisteredWebhook | null {
    return this.byRoute.get(route) ?? null
  }

  getById(connectorId: string, webhookId: string): RegisteredWebhook | null {
    return this.getByRoute(webhookRoute(connectorId, webhookId))
  }
}

export function webhookRoute(connectorId: string, webhookId: string): string {
  return `/api/webhooks/${connectorId}/${webhookId}`
}

function assertValidWebhook(
  connectorId: string,
  webhook: unknown
): asserts webhook is WebhookDefinition {
  if (!isRecord(webhook)) {
    throw new WebhookValidationError(`[Sixb] Connector '${connectorId}' has an invalid webhook.`)
  }

  if (webhook.kind !== "webhook") {
    throw new WebhookValidationError(
      `[Sixb] Connector '${connectorId}' webhook must be created with defineWebhook(...).`
    )
  }

  if (typeof webhook.id !== "string" || !webhook.id.trim()) {
    throw new WebhookValidationError(
      `[Sixb] Connector '${connectorId}' webhook id must not be empty.`
    )
  }

  if (webhook.method !== "POST") {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' must use method POST.`
    )
  }

  if (!isRecord(webhook.body)) {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' body is required.`
    )
  }

  if (
    webhook.body.format !== "json" &&
    webhook.body.format !== "text" &&
    webhook.body.format !== "raw"
  ) {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' body format must be json, text, or raw.`
    )
  }

  if (typeof webhook.body.parse !== "function") {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' body parser must provide parse(value).`
    )
  }

  if (webhook.verify !== undefined && typeof webhook.verify !== "function") {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' verify must be a function.`
    )
  }

  if (webhook.idempotencyKey !== undefined && typeof webhook.idempotencyKey !== "function") {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' idempotencyKey must be a function.`
    )
  }

  if (typeof webhook.handle !== "function") {
    throw new WebhookValidationError(
      `[Sixb] Webhook '${connectorId}/${webhook.id}' handle must be a function.`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
