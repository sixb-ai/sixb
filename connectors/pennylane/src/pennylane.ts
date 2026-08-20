import { type RestRetryContext, type RestRetryPolicy, rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createPennylaneClient } from "./client"
import { createPennylaneHttp } from "./http"
import type {
  PennylaneAccessTokenResolver,
  PennylaneClient,
  PennylaneConnectorOptions,
  PennylaneRequestMethod,
  PennylaneRetryContext,
  PennylaneRetryPolicy,
} from "./types"

const DEFAULT_BASE_URL = "https://app.pennylane.com/api/external/v2/"
const DEFAULT_MIN_DELAY_MS = 200
const DEFAULT_MAX_RETRIES = 2

export type PennylaneConnector = ConnectorAdapter<"pennylane", PennylaneClient>

export function pennylane(options: PennylaneConnectorOptions): PennylaneConnector {
  assertTokenResolver(options.accessToken)

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: `Bearer ${await resolveToken(options.accessToken)}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
    retry: toRestRetryPolicy(options.retry),
  })

  return {
    type: "pennylane",
    async connect(context) {
      assertReliabilityOptions(options)
      const restClient = await restAdapter.connect(context)
      return createPennylaneClient(createPennylaneHttp(restClient))
    },
  }
}

function toRestRetryPolicy(policy: PennylaneRetryPolicy | undefined): RestRetryPolicy {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(policy?.shouldRetry
      ? {
          shouldRetry: (context: RestRetryContext) =>
            policy.shouldRetry?.(toPennylaneRetryContext(context)) ?? false,
        }
      : {}),
    ...(policy?.delayMs
      ? {
          delayMs: (context: RestRetryContext) =>
            policy.delayMs?.(toPennylaneRetryContext(context)) ?? 0,
        }
      : {}),
  }
}

function toPennylaneRetryContext(context: RestRetryContext): PennylaneRetryContext {
  return {
    attempt: context.attempt,
    method: context.method as PennylaneRequestMethod,
    response: context.response,
    error: context.error,
  }
}

function assertReliabilityOptions(options: PennylaneConnectorOptions): void {
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbPennylane] retry.maxRetries must be a non-negative integer.")
  }
  const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbPennylane] minDelayMs must be a non-negative finite number.")
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertTokenResolver(token: PennylaneAccessTokenResolver): void {
  if (typeof token === "string" && !token.trim()) {
    throw new Error("[SixbPennylane] accessToken must not be empty.")
  }
  if (typeof token !== "string" && typeof token !== "function") {
    throw new Error("[SixbPennylane] accessToken must be a string or a function.")
  }
}

async function resolveToken(token: PennylaneAccessTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  if (!value.trim()) {
    throw new Error("[SixbPennylane] accessToken must not be empty.")
  }

  return value
}
