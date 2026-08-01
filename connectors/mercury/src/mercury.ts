import { rest } from "@sixb/connector-rest"
import {
  type ConnectorAdapter,
  resolveWebhookVerification,
  type WebhookDefinition,
} from "@sixb/core"
import { createMercuryClient } from "./client"
import { createMercuryHttp } from "./http"
import type { MercuryAccessTokenResolver, MercuryClient, MercuryConnectorOptions } from "./types"
import { createMercuryEventsWebhook, MERCURY_CONNECTOR_WEBHOOK } from "./webhooks"

const DEFAULT_BASE_URL = "https://api.mercury.com/api/v1/"

export type MercuryConnector = ConnectorAdapter<"mercury", MercuryClient>

/**
 * Mercury banking connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client grouped by resource (`accounts`, `transactions`, `categories`,
 * `customers`, `invoices`, `events`, …). Passing `onEvent` also registers an inbound webhook that
 * verifies Mercury's signature and forwards every delivery to the handler.
 *
 * ```ts
 * export const mercuryConnector = defineConnector("mercury", mercury({
 *   accessToken: process.env.MERCURY_API_TOKEN!,
 * }))
 * ```
 */
export function mercury(options: MercuryConnectorOptions): MercuryConnector {
  assertTokenResolver(options.accessToken)

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: `Bearer ${await resolveToken(options.accessToken)}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    // Retries are method-aware in the Mercury HTTP layer.
    retry: { maxRetries: 0 },
  })

  return {
    type: "mercury",
    webhooks: collectWebhooks(options),
    async connect(context) {
      const restClient = await restAdapter.connect(context)
      return createMercuryClient(
        createMercuryHttp(restClient, {
          minDelayMs: options.minDelayMs,
          retry: options.retry,
          signal: context.signal,
        })
      )
    },
  }
}

function collectWebhooks(
  options: MercuryConnectorOptions
): readonly WebhookDefinition<unknown, MercuryClient>[] | undefined {
  const webhooks: WebhookDefinition<unknown, MercuryClient>[] = []

  if (options.onEvent) {
    webhooks.push(
      createMercuryEventsWebhook(
        {
          onEvent: options.onEvent,
          // The secret usually arrives from the environment, so the decision is made here
          // rather than by the type: a secret, an explicit opt-in, or no webhook.
          ...resolveWebhookVerification(MERCURY_CONNECTOR_WEBHOOK, {
            credential: options.webhookSecret,
            allowUnverified: options.webhookAllowUnverified,
          }),
          toleranceMs: options.webhookToleranceMs,
        },
        MERCURY_CONNECTOR_WEBHOOK
      ) as WebhookDefinition<unknown, MercuryClient>
    )
  }

  if (options.webhooks) {
    webhooks.push(...options.webhooks)
  }

  return webhooks.length > 0 ? webhooks : undefined
}

/** Mercury paths are relative, so the base URL must end with a slash. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertTokenResolver(token: MercuryAccessTokenResolver): void {
  if (typeof token === "string" && !token.trim()) {
    throw new Error("[SixbMercury] accessToken must not be empty.")
  }
  if (typeof token !== "string" && typeof token !== "function") {
    throw new Error("[SixbMercury] accessToken must be a string or a function.")
  }
}

async function resolveToken(token: MercuryAccessTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  if (!value.trim()) {
    throw new Error("[SixbMercury] accessToken must not be empty.")
  }

  return value
}
