import {
  type RestRetryContext,
  type RestRetryPolicy,
  rest,
  shouldRetryRestRequest,
} from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createAceIotClient } from "./client"
import { AceIotConfigurationError } from "./errors"
import { createAceIotHttp } from "./http"
import type {
  AceIotApiKeyResolver,
  AceIotClient,
  AceIotConnectorOptions,
  AceIotRequestMethod,
  AceIotRetryContext,
  AceIotRetryPolicy,
} from "./types"

const DEFAULT_BASE_URL = "https://flightdeck.aceiot.cloud/api/"
const DEFAULT_MAX_RETRIES = 2

export type AceIotConnector = ConnectorAdapter<"ace-iot", AceIotClient>

export function aceIot(options: AceIotConnectorOptions): AceIotConnector {
  assertApiKeyResolver(options.apiKey)

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      // ACE rejects a bare token: the scheme is required even though its own spec calls this an
      // apiKey header.
      Authorization: `Bearer ${await resolveApiKey(options.apiKey)}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "ace-iot",
    async connect(context) {
      assertReliabilityOptions(options)
      const restClient = await restAdapter.connect(context)
      return createAceIotClient(createAceIotHttp(restClient))
    },
  }
}

function toRestRetryPolicy(policy: AceIotRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,
    shouldRetry(context) {
      const aceContext = toAceIotRetryContext(context)
      return (
        policy?.shouldRetry?.(aceContext) ??
        (!(context.error instanceof AceIotConfigurationError) && shouldRetryRestRequest(context))
      )
    },
    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) =>
            policy.delayMs?.(toAceIotRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

function toAceIotRetryContext(context: RestRetryContext): AceIotRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as AceIotRequestMethod,
    idempotent: context.idempotent,
    response: context.response,
    error: context.error,
  }
}

function assertReliabilityOptions(options: AceIotConnectorOptions): void {
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbAceIot] retry.maxRetries must be a non-negative integer.")
  }
  if (
    options.minDelayMs !== undefined &&
    (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0)
  ) {
    throw new Error("[SixbAceIot] minDelayMs must be a non-negative finite number.")
  }
}

/**
 * Every request path is relative, so the base URL has to end in a slash. Without one, `new URL()`
 * drops the last segment and `https://host/api` would resolve `sites/` to `https://host/sites/`.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    throw new AceIotConfigurationError("[SixbAceIot] baseUrl must not be empty.")
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function assertApiKeyResolver(apiKey: AceIotApiKeyResolver): void {
  if (typeof apiKey === "string" && !apiKey.trim()) {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must not be empty.")
  }
  if (typeof apiKey !== "string" && typeof apiKey !== "function") {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must be a string or a function.")
  }
}

async function resolveApiKey(apiKey: AceIotApiKeyResolver): Promise<string> {
  const value = typeof apiKey === "function" ? await apiKey() : apiKey
  if (!value.trim()) {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must not be empty.")
  }

  return value
}
