import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createLinkedinClient } from "./client"
import { LinkedinConfigurationError } from "./errors"
import { createLinkedinHttp } from "./http"
import { assertNonEmpty } from "./restli"
import type { LinkedinClient } from "./types/client"
import type { LinkedinAccessTokenResolver, LinkedinConnectorOptions } from "./types/options"

export const DEFAULT_LINKEDIN_BASE_URL = "https://api.linkedin.com/rest/"
export const DEFAULT_LINKEDIN_VERSION = "202608"
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = "2.0.0"
const DEFAULT_QUERY_TUNNELING_THRESHOLD = 3_500

export type LinkedinConnector = ConnectorAdapter<"linkedin", LinkedinClient>

/**
 * LinkedIn Advertising and Community Management API connector built on `@sixb/connector-rest`.
 *
 * Authentication is intentionally supplied as a token resolver. This keeps the API client
 * independent from token persistence and lets the upcoming managed OAuth connector provide the
 * same live token source without changing any resource implementation.
 */
export function linkedin(options: LinkedinConnectorOptions): LinkedinConnector {
  assertTokenResolver(options.accessToken)
  const version = options.version ?? DEFAULT_LINKEDIN_VERSION
  if (!/^\d{6}$/.test(version)) {
    throw new Error("[SixbLinkedin] version must use LinkedIn's YYYYMM format.")
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LINKEDIN_BASE_URL)
  const restAdapter = rest({
    baseUrl,
    headers: async () => ({
      Accept: "application/json",
      Authorization: `Bearer ${await resolveToken(options.accessToken)}`,
      "Linkedin-Version": version,
      "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    }),
    timeoutMs: options.timeoutMs,
    // Logical-method-aware retries and query tunneling live in the LinkedIn HTTP layer.
    retry: { maxRetries: 0 },
  })

  return {
    type: "linkedin",
    async connect(context) {
      const client = await restAdapter.connect(context)
      return createLinkedinClient(
        createLinkedinHttp(client, {
          minDelayMs: options.minDelayMs,
          retry: options.retry,
          signal: context.signal,
          queryTunnelingThreshold:
            options.queryTunnelingThreshold ?? DEFAULT_QUERY_TUNNELING_THRESHOLD,
        })
      )
    },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  assertNonEmpty(baseUrl, "baseUrl")
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertTokenResolver(token: LinkedinAccessTokenResolver): void {
  if (typeof token === "string" && !token.trim()) {
    throw new Error("[SixbLinkedin] accessToken must not be empty.")
  }
  if (typeof token !== "string" && typeof token !== "function") {
    throw new Error("[SixbLinkedin] accessToken must be a string or a function.")
  }
}

async function resolveToken(token: LinkedinAccessTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  if (!value.trim()) {
    throw new LinkedinConfigurationError("[SixbLinkedin] accessToken must not be empty.")
  }
  return value
}
