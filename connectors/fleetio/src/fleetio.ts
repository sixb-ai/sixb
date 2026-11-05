import {
  type RestRetryContext,
  type RestRetryPolicy,
  rest,
  shouldRetryRestRequest,
} from "@sixb/connector-rest"
import {
  type ConnectorAdapter,
  resolveWebhookVerification,
  type WebhookDefinition,
} from "@sixb/core"
import { createFleetioClient } from "./client"
import { FleetioConfigurationError } from "./errors"
import { createFleetioHttp } from "./http"
import type {
  FleetioClient,
  FleetioConnectorOptions,
  FleetioCredentialResolver,
  FleetioRequestMethod,
  FleetioRetryContext,
  FleetioRetryPolicy,
} from "./types"
import { createFleetioEventsWebhook, FLEETIO_CONNECTOR_WEBHOOK } from "./webhooks"

const DEFAULT_BASE_URL = "https://secure.fleetio.com/api/"
const DEFAULT_API_VERSION = "2025-05-05"
const DEFAULT_MAX_RETRIES = 2

export type FleetioConnector = ConnectorAdapter<"fleetio", FleetioClient>

/**
 * Fleetio connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client grouped by resource (`workOrders`, `vehicles`, `issues`, `parts`, …).
 * Passing `onEvent` also registers an inbound webhook that verifies Fleetio's signature and forwards
 * every delivery to the handler.
 *
 * ```ts
 * export const fleetioConnector = defineConnector("fleetio", fleetio({
 *   apiKey: process.env.FLEETIO_API_KEY!,
 *   accountToken: process.env.FLEETIO_ACCOUNT_TOKEN!,
 * }))
 * ```
 */
export function fleetio(options: FleetioConnectorOptions): FleetioConnector {
  assertCredentialResolver(options.apiKey, "apiKey")
  assertCredentialResolver(options.accountToken, "accountToken")

  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION
  if (!apiVersion.trim()) {
    throw new FleetioConfigurationError("[SixbFleetio] apiVersion must not be empty.")
  }

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: `Token ${await resolveCredential(options.apiKey, "apiKey")}`,
      "Account-Token": await resolveCredential(options.accountToken, "accountToken"),
      // A key is locked to the version current when it was created, and paths changed in
      // 2025-05-05, so the version is pinned here for every key to behave the same.
      "X-Api-Version": apiVersion,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "fleetio",
    webhooks: options.onEvent
      ? [
          createFleetioEventsWebhook(
            {
              onEvent: options.onEvent,
              // The secret usually arrives from the environment, so the decision is made here
              // rather than by the type: a secret, an explicit opt-in, or no webhook.
              ...resolveWebhookVerification(FLEETIO_CONNECTOR_WEBHOOK, {
                credential: options.webhookSecret,
                allowUnverified: options.webhookAllowUnverified,
              }),
            },
            FLEETIO_CONNECTOR_WEBHOOK
          ) as WebhookDefinition<unknown, FleetioClient>,
        ]
      : undefined,
    async connect(context) {
      assertReliabilityOptions(options)
      const restClient = await restAdapter.connect(context)
      return createFleetioClient(createFleetioHttp(restClient))
    },
  }
}

function toRestRetryPolicy(policy: FleetioRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,
    shouldRetry(context) {
      return policy?.shouldRetry?.(toFleetioRetryContext(context)) ?? shouldRetryByDefault(context)
    },
    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) =>
            policy.delayMs?.(toFleetioRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

/**
 * Reads retry network errors, 429 and 5xx. Fleetio has no idempotency keys, so a write retries only
 * on a 429: the request was refused, and replaying it cannot create a second record.
 */
function shouldRetryByDefault(context: RestRetryContext): boolean {
  if (context.error instanceof FleetioConfigurationError) {
    return false
  }

  return context.response?.status === 429 || shouldRetryRestRequest(context)
}

function toFleetioRetryContext(context: RestRetryContext): FleetioRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as FleetioRequestMethod,
    idempotent: context.idempotent,
    response: context.response,
    error: context.error,
  }
}

function assertReliabilityOptions(options: FleetioConnectorOptions): void {
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbFleetio] retry.maxRetries must be a non-negative integer.")
  }
  if (
    options.minDelayMs !== undefined &&
    (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0)
  ) {
    throw new Error("[SixbFleetio] minDelayMs must be a non-negative finite number.")
  }
}

/** Fleetio paths are relative, so the base URL must end with a slash. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    throw new FleetioConfigurationError("[SixbFleetio] baseUrl must not be empty.")
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function assertCredentialResolver(credential: FleetioCredentialResolver, field: string): void {
  if (typeof credential === "string" && !credential.trim()) {
    throw new FleetioConfigurationError(`[SixbFleetio] ${field} must not be empty.`)
  }
  if (typeof credential !== "string" && typeof credential !== "function") {
    throw new FleetioConfigurationError(`[SixbFleetio] ${field} must be a string or a function.`)
  }
}

async function resolveCredential(
  credential: FleetioCredentialResolver,
  field: string
): Promise<string> {
  const value = typeof credential === "function" ? await credential() : credential
  if (!value.trim()) {
    throw new FleetioConfigurationError(`[SixbFleetio] ${field} must not be empty.`)
  }

  return value
}
