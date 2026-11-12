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
import { createCtmClient } from "./client"
import { CtmConfigurationError } from "./errors"
import { createCtmHttp } from "./http"
import type {
  CtmClient,
  CtmConnectorOptions,
  CtmCredentialResolver,
  CtmRequestMethod,
  CtmRetryContext,
  CtmRetryPolicy,
} from "./types"
import { pathId } from "./validation"
import { CTM_CONNECTOR_WEBHOOK, createCtmEventsWebhook } from "./webhooks"

const DEFAULT_BASE_URL = "https://api.calltrackingmetrics.com/api/v1/"
const DEFAULT_MAX_RETRIES = 2
/** CTM allows 10 requests a second per key. */
const DEFAULT_MIN_DELAY_MS = 100

export type CtmConnector = ConnectorAdapter<"ctm", CtmClient>

/**
 * CallTrackingMetrics connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client grouped by resource (`calls`, `trackingNumbers`, `users`, …) for one
 * account, with `account(id)` for the others an agency key reaches. Passing `onEvent` also
 * registers an inbound webhook that checks CTM's basic auth and forwards each activity.
 *
 * ```ts
 * export const ctmConnector = defineConnector("ctm", ctm({
 *   accessKey: process.env.CTM_ACCESS_KEY!,
 *   secretKey: process.env.CTM_SECRET_KEY!,
 *   accountId: 12345,
 * }))
 * ```
 */
export function ctm(options: CtmConnectorOptions): CtmConnector {
  assertCredentialResolver(options.accessKey, "accessKey")
  assertCredentialResolver(options.secretKey, "secretKey")

  if (options.accountId !== undefined) {
    pathId(options.accountId, "accountId", CtmConfigurationError)
  }

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: await basicAuthorization(options),
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "ctm",
    webhooks: options.onEvent
      ? [
          createCtmEventsWebhook(
            {
              onEvent: options.onEvent,
              // The credential usually arrives from the environment, so the decision is made here
              // rather than by the type: a credential, an explicit opt-in, or no webhook.
              ...resolveWebhookVerification(CTM_CONNECTOR_WEBHOOK, {
                credential: options.webhookAuth,
                allowUnverified: options.webhookAllowUnverified,
              }),
            },
            CTM_CONNECTOR_WEBHOOK
          ) as WebhookDefinition<unknown, CtmClient>,
        ]
      : undefined,

    async connect(context) {
      assertReliabilityOptions(options)

      const restClient = await restAdapter.connect(context)

      return createCtmClient(createCtmHttp(restClient), options.accountId)
    },
  }
}

async function basicAuthorization(options: CtmConnectorOptions): Promise<string> {
  const accessKey = await resolveCredential(options.accessKey, "accessKey")
  const secretKey = await resolveCredential(options.secretKey, "secretKey")

  return `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString("base64")}`
}

function toRestRetryPolicy(policy: CtmRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,

    shouldRetry(context) {
      return policy?.shouldRetry?.(toCtmRetryContext(context)) ?? shouldRetryByDefault(context)
    },

    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) => policy.delayMs?.(toCtmRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

/**
 * Reads retry network errors, 429 and 5xx. CTM has no idempotency keys, so a write retries only on
 * a 429: the request was refused, and replaying it cannot apply it twice.
 */
function shouldRetryByDefault(context: RestRetryContext): boolean {
  if (context.error instanceof CtmConfigurationError) {
    return false
  }

  return context.response?.status === 429 || shouldRetryRestRequest(context)
}

function toCtmRetryContext(context: RestRetryContext): CtmRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as CtmRequestMethod,
    idempotent: context.idempotent,
    response: context.response,
    error: context.error,
  }
}

function assertReliabilityOptions(options: CtmConnectorOptions): void {
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbCtm] retry.maxRetries must be a non-negative integer.")
  }

  if (
    options.minDelayMs !== undefined &&
    (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0)
  ) {
    throw new Error("[SixbCtm] minDelayMs must be a non-negative finite number.")
  }
}

/** CTM paths are relative, so the base URL must end with a slash. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    throw new CtmConfigurationError("[SixbCtm] baseUrl must not be empty.")
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function assertCredentialResolver(credential: CtmCredentialResolver, field: string): void {
  if (typeof credential === "string" && !credential.trim()) {
    throw new CtmConfigurationError(`[SixbCtm] ${field} must not be empty.`)
  }

  if (typeof credential !== "string" && typeof credential !== "function") {
    throw new CtmConfigurationError(`[SixbCtm] ${field} must be a string or a function.`)
  }
}

async function resolveCredential(
  credential: CtmCredentialResolver,
  field: string
): Promise<string> {
  const value = typeof credential === "function" ? await credential() : credential

  if (typeof value !== "string" || !value.trim()) {
    throw new CtmConfigurationError(`[SixbCtm] ${field} must not be empty.`)
  }

  return value
}
