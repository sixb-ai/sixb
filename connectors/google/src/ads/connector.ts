import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter, ConnectorContext } from "@sixb/core"
import { createTokenSource } from "../auth"
import { createGoogleAdsClient, type GoogleAdsClient } from "./client"
import { createGoogleAdsHttp } from "./http"
import type { GoogleAdsConnectorOptions } from "./types"
import {
  assertGoogleAdsScope,
  assertMajorApiVersion,
  assertNonEmpty,
  GOOGLE_ADS_SCOPE,
  normalizeCustomerId,
} from "./validation"

export { GOOGLE_ADS_SCOPE }
export const DEFAULT_GOOGLE_ADS_API_VERSION = "v25" as const
const DEFAULT_GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com/"

export type GoogleAdsConnector = ConnectorAdapter<"google-ads", GoogleAdsClient>

/** Read-only Google Ads reporting connector for one manager-account hierarchy. */
export function googleAds(options: GoogleAdsConnectorOptions): GoogleAdsConnector {
  assertNonEmpty(options.developerToken, "developerToken")
  const developerToken = options.developerToken.trim()
  assertGoogleAdsScope(options.auth)
  const loginCustomerId = normalizeCustomerId(options.loginCustomerId, "loginCustomerId")
  const apiVersion = options.apiVersion ?? DEFAULT_GOOGLE_ADS_API_VERSION
  assertMajorApiVersion(apiVersion)
  const baseUrl = versionedBaseUrl(options.baseUrl ?? DEFAULT_GOOGLE_ADS_BASE_URL, apiVersion)
  const token = createTokenSource(options.auth)

  return {
    type: "google-ads",
    async connect(context) {
      const api = await rest({
        baseUrl,
        headers: async ({ path }) => {
          const authHeaders = token.getRequestHeaders
            ? await token.getRequestHeaders()
            : new Headers({ Authorization: `Bearer ${await token.get()}` })
          // Clone rather than spread so ADC metadata such as x-goog-user-project survives.
          const headers = new Headers(authHeaders)
          headers.set("accept", "application/json")
          headers.set("developer-token", developerToken)
          // This endpoint only reports direct grants and explicitly ignores login-customer-id.
          if (!path.endsWith("customers:listAccessibleCustomers")) {
            headers.set("login-customer-id", loginCustomerId)
          }
          return headers
        },
        onUnauthorized: () => token.invalidate(),
        retry: { ...defaultRetry(context), ...options.retry },
        timeoutMs: options.timeoutMs,
        minDelayMs: options.minDelayMs,
      }).connect(context)
      return createGoogleAdsClient(createGoogleAdsHttp(api, context.signal), loginCustomerId)
    },
  }
}

function versionedBaseUrl(baseUrl: string, apiVersion: string): string {
  assertNonEmpty(baseUrl, "baseUrl")
  const trimmed = baseUrl.trim()
  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`
  return `${normalized}${apiVersion}/`
}

function defaultRetry(context: ConnectorContext) {
  return {
    maxRetries: 2,
    shouldRetry({ response, error }: { response: Response | null; error: unknown }) {
      if (context.signal.aborted || isAbortError(error)) {
        return false
      }
      return error != null || response?.status === 429 || (response?.status ?? 0) >= 500
    },
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
