import { type RestRetryContext, type RestRetryPolicy, rest } from "@sixb/connector-rest"
import {
  type ConnectorAdapter,
  resolveWebhookVerification,
  type WebhookDefinition,
} from "@sixb/core"
import { createUnipileClient } from "./client"
import { createUnipileHttp } from "./http"
import type {
  UnipileAccessTokenResolver,
  UnipileClient,
  UnipileConnectorOptions,
  UnipileRequestMethod,
  UnipileRetryContext,
  UnipileRetryPolicy,
} from "./types"
import { createUnipileEventsWebhook, UNIPILE_CONNECTOR_WEBHOOK } from "./webhooks"

export type UnipileConnector = ConnectorAdapter<"unipile", UnipileClient>

const DEFAULT_MAX_RETRIES = 2

/** Unipile v1 connector for messaging and LinkedIn outreach. */
export function unipile(options: UnipileConnectorOptions): UnipileConnector {
  const { apiBaseUrl, dsn } = normalizeDsn(options.dsn)
  assertTokenResolver(options.accessToken)
  assertOptionalPositive(options.timeoutMs, "timeoutMs")
  assertOptionalNonNegative(options.minDelayMs, "minDelayMs")
  if (options.webhookSecret !== undefined) {
    assertNonEmpty(options.webhookSecret, "webhookSecret")
  }

  const restAdapter = rest({
    baseUrl: apiBaseUrl,
    headers: async () => ({
      "X-API-KEY": await resolveToken(options.accessToken),
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "unipile",
    webhooks: collectWebhooks(options),
    async connect(context) {
      assertRetryPolicy(options.retry)
      const restClient = await restAdapter.connect(context)
      return createUnipileClient(createUnipileHttp(restClient), {
        dsn,
        webhookSecret: options.webhookSecret,
      })
    },
  }
}

function toRestRetryPolicy(policy: UnipileRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,
    shouldRetry(context) {
      const unipileContext = toUnipileRetryContext(context)
      return policy?.shouldRetry?.(unipileContext) ?? shouldRetryByDefault(unipileContext)
    },
    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) =>
            policy.delayMs?.(toUnipileRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

function toUnipileRetryContext(context: RestRetryContext): UnipileRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as UnipileRequestMethod,
    path: context.path.split("?", 1)[0] ?? context.path,
    response: context.response,
    error: context.error,
  }
}

function shouldRetryByDefault(context: UnipileRetryContext): boolean {
  if (context.error) {
    // Native fetch reports transport failures as TypeError. Credential-resolver and caller errors
    // keep their original diagnostics and are not replayed.
    return context.error instanceof TypeError
  }
  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

function assertRetryPolicy(policy: UnipileRetryPolicy | undefined): void {
  const maxRetries = policy?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbUnipile] retry.maxRetries must be a non-negative integer.")
  }
}

function collectWebhooks(
  options: UnipileConnectorOptions
): readonly WebhookDefinition<unknown, UnipileClient>[] | undefined {
  if (!options.onEvent) {
    return undefined
  }

  return [
    createUnipileEventsWebhook(
      {
        onEvent: options.onEvent,
        ...resolveWebhookVerification(UNIPILE_CONNECTOR_WEBHOOK, {
          credential: options.webhookSecret,
          allowUnverified: options.webhookAllowUnverified,
        }),
      },
      UNIPILE_CONNECTOR_WEBHOOK
    ) as WebhookDefinition<unknown, UnipileClient>,
  ]
}

function normalizeDsn(value: string): { dsn: string; apiBaseUrl: string } {
  assertNonEmpty(value, "dsn")

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[SixbUnipile] dsn must be a valid HTTP(S) origin.")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("[SixbUnipile] dsn must be a valid HTTP(S) origin.")
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error(
      "[SixbUnipile] dsn must be an origin without credentials, path, query, or hash."
    )
  }

  const dsn = url.origin
  return { dsn, apiBaseUrl: `${dsn}/api/v1/` }
}

function assertTokenResolver(token: UnipileAccessTokenResolver): void {
  if (typeof token === "string") {
    assertNonEmpty(token, "accessToken")
    return
  }
  if (typeof token !== "function") {
    throw new Error("[SixbUnipile] accessToken must be a string or a function.")
  }
}

async function resolveToken(token: UnipileAccessTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  assertNonEmpty(value, "accessToken")
  return value
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`[SixbUnipile] ${field} must not be empty.`)
  }
}

function assertOptionalPositive(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`[SixbUnipile] ${field} must be a positive finite number.`)
  }
}

function assertOptionalNonNegative(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`[SixbUnipile] ${field} must be a non-negative finite number.`)
  }
}
