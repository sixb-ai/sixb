import { rest } from "@sixb/connector-rest"
import { type ConnectorAdapter, resolveWebhookVerification } from "@sixb/core"
import type { CompanyCamClient, CompanyCamConnectorOptions } from "./client"
import { createCompanyCamClient } from "./client"
import { COMPANYCAM_CONNECTOR_WEBHOOK, createCompanyCamEventsWebhook } from "./events"
import { createHttp } from "./http"

const DEFAULT_BASE_URL = "https://api.companycam.com/v2/"

export type CompanyCamConnector = ConnectorAdapter<"companycam", CompanyCamClient>

/**
 * CompanyCam connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client grouped by resource (`projects`, `photos`, `webhooks`).
 * When `onEvent` is provided it also registers an inbound webhook that verifies
 * CompanyCam's signature and forwards every event to the handler.
 *
 * ```ts
 * export const companycamConnector = defineConnector("companycam", companycam({
 *   token: process.env.COMPANYCAM_TOKEN!,
 * }))
 * ```
 */
export function companycam(options: CompanyCamConnectorOptions): CompanyCamConnector {
  assertNonEmpty(options.token, "token")

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/json",
    },
    retry: { maxRetries: 2 },
  })

  return {
    type: "companycam",
    webhooks: options.onEvent
      ? [
          createCompanyCamEventsWebhook(
            {
              // The secret usually arrives from the environment, so the decision is made
              // here rather than by the type: a secret, an explicit opt-in, or no webhook.
              ...resolveWebhookVerification(COMPANYCAM_CONNECTOR_WEBHOOK, {
                credential: options.webhookSecret,
                allowUnverified: options.webhookAllowUnverified,
              }),
              onEvent: options.onEvent,
            },
            COMPANYCAM_CONNECTOR_WEBHOOK
          ),
        ]
      : undefined,
    async connect(context) {
      const http = createHttp(await restAdapter.connect(context))
      return createCompanyCamClient(http, options.webhookSecret)
    },
  }
}

/** CompanyCam paths are relative, so the base URL must end with a slash. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbCompanyCam] ${field} must not be empty.`)
  }
}
