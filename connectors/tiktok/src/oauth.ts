import {
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import { assertNonEmpty, TIKTOK_API_BASE_URL } from "./http"
import type {
  TiktokAdsConnectorOptions,
  TiktokConnectorOptions,
  TiktokOrganicConnectorOptions,
} from "./types/options"

const MARKETING_AUTHORIZATION_URL = "https://ads.tiktok.com/marketing_api/auth"

interface OAuthEnvelope {
  readonly code: number
  readonly message: string
  readonly request_id?: string
  readonly data: unknown
}

type OAuthOperation = "exchange" | "refresh" | "revoke"

export function createTiktokAuthentication(
  options: TiktokConnectorOptions
): ConnectorOAuth2Authentication {
  return options.api === "organic"
    ? createOrganicAuthentication(options)
    : createMarketingAuthentication(options)
}

export function organicRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri)
  if (url.protocol !== "https:" || url.port || url.search || url.hash) {
    throw new Error(
      "[SixbTikTok] The organic redirect URI must use HTTPS without a port, query, or fragment."
    )
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  const normalized = url.toString()
  if (normalized.length < 10 || normalized.length > 512) {
    throw new Error("[SixbTikTok] The organic redirect URI must be between 10 and 512 characters.")
  }
  return normalized
}

function createOrganicAuthentication(
  options: TiktokOrganicConnectorOptions
): ConnectorOAuth2Authentication {
  return {
    type: "oauth2",
    authorizationUrl(context, input) {
      const url = new URL(options.authorizationUrl)
      if (url.protocol !== "https:") {
        throw new Error("[SixbTikTok] authorizationUrl must use HTTPS.")
      }
      url.searchParams.set("redirect_uri", organicRedirectUri(context.redirectUri))
      url.searchParams.set("state", input.state)
      addFrameworkPkce(url, input.codeChallenge, input.codeChallengeMethod)
      if (options.disableAutoAuth) url.searchParams.set("disable_auto_auth", "1")
      return url
    },
    async exchangeCode(context, input) {
      const data = await oauthRequest(
        context,
        options,
        "tt_user/oauth2/token/",
        {
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: "authorization_code",
          auth_code: input.code,
          redirect_uri: organicRedirectUri(context.redirectUri),
        },
        "exchange"
      )
      return organicCredentials(data)
    },
    async refresh(context, credentials) {
      if (!credentials.refreshToken) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbTikTok] The TikTok organic grant has no refresh token; reauthorization is required."
        )
      }
      const data = await oauthRequest(
        context,
        options,
        "tt_user/oauth2/refresh_token/",
        {
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        },
        "refresh"
      )
      return organicCredentials(data)
    },
    async revoke(context, credentials) {
      await revokeGrant(context, options, "tt_user/oauth2/revoke/", {
        client_id: options.clientId,
        client_secret: options.clientSecret,
        access_token: credentials.accessToken,
      })
    },
  }
}

function createMarketingAuthentication(
  options: TiktokAdsConnectorOptions
): ConnectorOAuth2Authentication {
  return {
    type: "oauth2",
    authorizationUrl(context, input) {
      const url = new URL(MARKETING_AUTHORIZATION_URL)
      url.searchParams.set("app_id", options.appId)
      url.searchParams.set("state", input.state)
      url.searchParams.set("redirect_uri", context.redirectUri)
      if (options.scope) url.searchParams.set("scope", options.scope)
      addFrameworkPkce(url, input.codeChallenge, input.codeChallengeMethod)
      return url
    },
    async exchangeCode(context, input) {
      const data = await oauthRequest(
        context,
        options,
        "oauth2/access_token/",
        {
          app_id: options.appId,
          secret: options.secret,
          auth_code: input.code,
          return_advertiser_ids: true,
        },
        "exchange"
      )
      return marketingCredentials(data, options.scope)
    },
    refresh() {
      throw new ConnectorOAuthError(
        "terminal",
        "[SixbTikTok] TikTok Marketing API access tokens do not refresh; reauthorization is required."
      )
    },
    async revoke(context, credentials) {
      await revokeGrant(
        context,
        options,
        "oauth2/revoke_token/",
        {
          app_id: options.appId,
          secret: options.secret,
          access_token: credentials.accessToken,
        },
        { "Access-Token": credentials.accessToken }
      )
    },
  }
}

function addFrameworkPkce(url: URL, challenge: string, method: "S256"): void {
  // TikTok does not document PKCE for either Business API flow. Sixb still requires a challenge
  // on the authorization request; the verifier is deliberately not sent to TikTok's token APIs.
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", method)
}

function organicCredentials(data: unknown): ConnectorOAuthCredentials {
  if (!isRecord(data)) throw malformedTokenResponse("data")
  const accessToken = requiredString(data.access_token, "access_token")
  const refreshToken = requiredString(data.refresh_token, "refresh_token")
  const expiresIn = requiredPositiveNumber(data.expires_in, "expires_in")
  requiredPositiveNumber(data.refresh_token_expires_in, "refresh_token_expires_in")
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

function marketingCredentials(data: unknown, scope: string | undefined): ConnectorOAuthCredentials {
  if (!isRecord(data)) throw malformedTokenResponse("data")
  const accessToken = requiredString(data.access_token, "access_token")
  return {
    accessToken,
    tokenType: "Bearer",
    // TikTok returns numeric permission IDs, including values beyond Number.MAX_SAFE_INTEGER.
    // Preserve only the exact caller-provided scope string in Sixb's normalized credentials.
    scopes: scope ? [scope] : undefined,
  }
}

async function revokeGrant(
  context: ConnectorContext,
  options: TiktokConnectorOptions,
  path: string,
  body: unknown,
  headers?: HeadersInit
): Promise<void> {
  try {
    await oauthRequest(context, options, path, body, "revoke", headers)
  } catch (error) {
    if (error instanceof ConnectorOAuthError && isAlreadyRevoked(error.message)) return
    throw error
  }
}

async function oauthRequest(
  context: ConnectorContext,
  options: TiktokConnectorOptions,
  path: string,
  body: unknown,
  operation: OAuthOperation,
  extraHeaders?: HeadersInit
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
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(extraHeaders)),
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok OAuth ${operation} ended without a provider response.`,
      { cause: error }
    )
  }

  let rawBody: string
  try {
    rawBody = await response.text()
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok OAuth ${operation} response could not be read.`,
      { cause: error }
    )
  }
  const envelope = parseOAuthEnvelope(rawBody)
  if (!response.ok || (envelope && envelope.code !== 0)) {
    const detail = envelope?.message || `HTTP ${response.status}`
    const request = envelope?.request_id ? ` (request ${envelope.request_id})` : ""
    throw new ConnectorOAuthError(
      response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
      `[SixbTikTok] TikTok OAuth ${operation} failed: ${detail}${request}.`
    )
  }
  if (!envelope) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbTikTok] TikTok OAuth ${operation} returned a malformed success response.`
    )
  }
  return envelope.data
}

function parseOAuthEnvelope(rawBody: string): OAuthEnvelope | undefined {
  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    typeof value.message !== "string" ||
    !("data" in value)
  ) {
    return undefined
  }
  return {
    code: value.code,
    message: value.message,
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
    data: value.data,
  }
}

function normalizedBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl ?? TIKTOK_API_BASE_URL
  assertNonEmpty(value, "baseUrl")
  return value.endsWith("/") ? value : `${value}/`
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
