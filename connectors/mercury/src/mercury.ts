import { type RestRetryContext, type RestRetryPolicy, rest } from "@sixb/connector-rest"
import {
  type ConnectorAdapter,
  resolveWebhookVerification,
  type WebhookDefinition,
} from "@sixb/core"
import { createMercuryClient } from "./client"
import { createMercuryHttp } from "./http"
import type {
  MercuryAccessTokenResolver,
  MercuryClient,
  MercuryConnectorOptions,
  MercuryRequestMethod,
  MercuryRetryContext,
  MercuryRetryPolicy,
} from "./types"
import { createMercuryEventsWebhook, MERCURY_CONNECTOR_WEBHOOK } from "./webhooks"

const DEFAULT_BASE_URL = "https://api.mercury.com/api/v1/"
const DEFAULT_MAX_RETRIES = 2

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
    minDelayMs: options.minDelayMs,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "mercury",
    webhooks: collectWebhooks(options),
    async connect(context) {
      assertReliabilityOptions(options)
      const restClient = await restAdapter.connect(context)
      return createMercuryClient(createMercuryHttp(restClient))
    },
  }
}

function toRestRetryPolicy(policy: MercuryRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(policy?.shouldRetry
      ? {
          shouldRetry: (context: RestRetryContext) =>
            policy.shouldRetry?.(toMercuryRetryContext(context)) ?? false,
        }
      : {}),
    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) =>
            policy.delayMs?.(toMercuryRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

function toMercuryRetryContext(context: RestRetryContext): MercuryRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as MercuryRequestMethod,
    response: context.response,
    error: context.error,
  }
}

function assertReliabilityOptions(options: MercuryConnectorOptions): void {
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbMercury] retry.maxRetries must be a non-negative integer.")
  }
  if (
    options.minDelayMs !== undefined &&
    (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0)
  ) {
    throw new Error("[SixbMercury] minDelayMs must be a non-negative finite number.")
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
