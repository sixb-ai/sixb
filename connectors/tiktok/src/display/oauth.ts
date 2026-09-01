import {
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import { assertNonEmpty } from "../http"
import type { TiktokDisplayConnectorOptions } from "../types/options"
import { TIKTOK_DISPLAY_API_BASE_URL } from "./http"

const DISPLAY_AUTHORIZATION_URL = "https://www.tiktok.com/v2/auth/authorize/"
const DISPLAY_DEFAULT_SCOPES = ["user.info.basic", "video.list"] as const

type OAuthOperation = "exchange" | "refresh" | "revoke"

export function createDisplayAuthentication(
  options: TiktokDisplayConnectorOptions
): ConnectorOAuth2Authentication {
  return {
    type: "oauth2",
    authorizationUrl(context, input) {
      const url = new URL(DISPLAY_AUTHORIZATION_URL)
      url.searchParams.set("client_key", options.clientKey)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", (options.scopes ?? DISPLAY_DEFAULT_SCOPES).join(","))
      url.searchParams.set("redirect_uri", displayRedirectUri(context.redirectUri))
      url.searchParams.set("state", input.state)
      if (options.disableAutoAuth) url.searchParams.set("disable_auto_auth", "1")
      // Login Kit Web relies on state for CSRF protection. TikTok only documents PKCE for its
      // mobile and desktop flows, so Sixb's framework challenge is intentionally not forwarded.
      return url
    },
    async exchangeCode(context, input) {
      const data = await displayOAuthRequest(
        context,
        options,
        "oauth/token/",
        {
          client_key: options.clientKey,
          client_secret: options.clientSecret,
          code: input.code,
          grant_type: "authorization_code",
          redirect_uri: displayRedirectUri(context.redirectUri),
        },
        "exchange"
      )
      return displayCredentials(data)
    },
    async refresh(context, credentials) {
      if (!credentials.refreshToken) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbTikTok] The TikTok Display grant has no refresh token; reauthorization is required."
        )
      }
      const data = await displayOAuthRequest(
        context,
        options,
        "oauth/token/",
        {
          client_key: options.clientKey,
          client_secret: options.clientSecret,
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        },
        "refresh"
      )
      return displayCredentials(data)
    },
    async revoke(context, credentials) {
      try {
        await displayOAuthRequest(
          context,
          options,
          "oauth/revoke/",
          {
            client_key: options.clientKey,
            client_secret: options.clientSecret,
            token: credentials.accessToken,
          },
          "revoke",
          true
        )
      } catch (error) {
        if (error instanceof ConnectorOAuthError && isAlreadyRevoked(error.message)) return
        throw error
      }
    },
  }
}

function displayRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri)
  if (url.protocol !== "https:" || url.search || url.hash) {
    throw new Error(
      "[SixbTikTok] The Display redirect URI must use HTTPS without a query or fragment."
    )
  }
  const normalized = url.toString()
  if (normalized.length >= 512) {
    throw new Error("[SixbTikTok] The Display redirect URI must be shorter than 512 characters.")
  }
  return normalized
}

function displayCredentials(data: unknown): ConnectorOAuthCredentials {
  if (!isRecord(data)) throw malformedTokenResponse("response")
  requiredString(data.open_id, "open_id")
  const accessToken = requiredString(data.access_token, "access_token")
  const refreshToken = requiredString(data.refresh_token, "refresh_token")
  const expiresIn = requiredPositiveNumber(data.expires_in, "expires_in")
  requiredPositiveNumber(data.refresh_expires_in, "refresh_expires_in")
  const scope = requiredString(data.scope, "scope")
  const tokenType = requiredString(data.token_type, "token_type")
  return {
    accessToken,
    refreshToken,
    tokenType,
    scopes: splitScopes(scope),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  }
}

async function displayOAuthRequest(
  context: ConnectorContext,
  options: TiktokDisplayConnectorOptions,
  path: string,
  body: Readonly<Record<string, string>>,
  operation: OAuthOperation,
  allowEmptySuccess = false
): Promise<unknown> {
  let response: Response
  try {
    const signal = options.timeoutMs
      ? AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)])
      : context.signal
    response = await fetch(new URL(path, normalizedBaseUrl(options.baseUrl)), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      signal,
    })
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok Display OAuth ${operation} ended without a provider response.`,
      { cause: error }
    )
  }

  let rawBody: string
  try {
    rawBody = await response.text()
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok Display OAuth ${operation} response could not be read.`,
      { cause: error }
    )
  }

  const parsed = parseJsonRecord(rawBody)
  const providerError =
    (typeof parsed?.error_description === "string" && parsed.error_description) ||
    (typeof parsed?.error === "string" && parsed.error)
  if (!response.ok || providerError) {
    const detail = providerError || `HTTP ${response.status}`
    const logId = typeof parsed?.log_id === "string" ? ` (log ${parsed.log_id})` : ""
    throw new ConnectorOAuthError(
      response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
      `[SixbTikTok] TikTok Display OAuth ${operation} failed: ${detail}${logId}.`
    )
  }

  if (!rawBody.trim() && allowEmptySuccess) return {}
  if (!parsed) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok Display OAuth ${operation} returned a malformed success response.`
    )
  }
  return parsed
}

function normalizedBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl ?? TIKTOK_DISPLAY_API_BASE_URL
  assertNonEmpty(value, "baseUrl")
  return value.endsWith("/") ? value : `${value}/`
}

function parseJsonRecord(rawBody: string): Record<string, unknown> | undefined {
  if (!rawBody) return undefined
  try {
    const value: unknown = JSON.parse(rawBody)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw malformedTokenResponse(field)
  return value
}

function requiredPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw malformedTokenResponse(field)
  }
  return value
}

function malformedTokenResponse(field: string): ConnectorOAuthError {
  return new ConnectorOAuthError(
    "ambiguous",
    `[SixbTikTok] TikTok returned an invalid OAuth token field '${field}'.`
  )
}

function splitScopes(value: string): readonly string[] | undefined {
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
  return scopes.length ? scopes : undefined
}

function isAlreadyRevoked(message: string): boolean {
  return /(?:already revoked|invalid|expired|not exist).*token|token.*(?:already revoked|invalid|expired|not exist)/i.test(
    message
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
