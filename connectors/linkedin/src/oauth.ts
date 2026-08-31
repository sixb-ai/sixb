import {
  type ConnectorContext,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type OAuthConnectorAuthorizationContext,
  type OAuthConnectorAuthorizationUrlInput,
  type OAuthConnectorCodeExchangeInput,
} from "@sixb/core"
import { assertNonEmpty } from "./restli"
import type { LinkedinOAuthScope } from "./types/options"

export const LINKEDIN_AUTHORIZATION_URL = "https://www.linkedin.com/oauth/v2/authorization"
export const LINKEDIN_ACCESS_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
export const LINKEDIN_PERMITTED_SERVICES_URL =
  "https://www.linkedin.com/psettings/permitted-services"

export interface LinkedinOAuthOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly scopes: readonly LinkedinOAuthScope[]
}

export function createLinkedinOAuth(options: LinkedinOAuthOptions) {
  const clientId = nonEmpty(options.clientId, "clientId")
  const clientSecret = nonEmpty(options.clientSecret, "clientSecret")
  const scopes = normalizeScopes(options.scopes)

  return {
    authorizationUrl(
      context: OAuthConnectorAuthorizationContext,
      input: OAuthConnectorAuthorizationUrlInput
    ): URL {
      const url = new URL(LINKEDIN_AUTHORIZATION_URL)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", clientId)
      url.searchParams.set("redirect_uri", context.redirectUri)
      url.searchParams.set("state", input.state)
      url.searchParams.set("scope", scopes.join(" "))

      // Sixb currently requires these parameters for every managed OAuth adapter. LinkedIn's
      // confidential web flow does not document PKCE and its native PKCE flow only accepts
      // loopback redirects, so the verifier is deliberately not sent during the token exchange.
      url.searchParams.set("code_challenge", input.codeChallenge)
      url.searchParams.set("code_challenge_method", input.codeChallengeMethod)
      return url
    },

    exchangeCode(
      context: OAuthConnectorAuthorizationContext,
      input: OAuthConnectorCodeExchangeInput
    ): Promise<ConnectorOAuthCredentials> {
      return exchangeToken(
        {
          grant_type: "authorization_code",
          code: input.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: context.redirectUri,
        },
        context,
        "authorization code"
      )
    },

    async refresh(
      context: ConnectorContext,
      credentials: ConnectorOAuthCredentials
    ): Promise<ConnectorOAuthCredentials> {
      if (!credentials.refreshToken) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbLinkedin] LinkedIn did not issue a programmatic refresh token; reauthorization is required."
        )
      }
      return exchangeToken(
        {
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        },
        context,
        "refresh token"
      )
    },
  } as const
}

async function exchangeToken(
  parameters: Readonly<Record<string, string>>,
  context: ConnectorContext,
  operation: "authorization code" | "refresh token"
): Promise<ConnectorOAuthCredentials> {
  let response: Response
  try {
    response = await fetch(LINKEDIN_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
      signal: context.signal,
    })
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn ${operation} exchange outcome is unknown.`,
      { cause: error }
    )
  }

  let body: unknown
  try {
    body = await readBody(response)
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn ${operation} response could not be read.`,
      { cause: error }
    )
  }
  if (!response.ok) {
    const kind =
      response.status === 429 ? "retryable" : response.status < 500 ? "terminal" : "ambiguous"
    throw new ConnectorOAuthError(
      kind,
      `[SixbLinkedin] LinkedIn rejected the ${operation} exchange (${response.status})${providerMessage(body)}.`
    )
  }

  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned an invalid ${operation} response.`
    )
  }

  const expiresIn = positiveSeconds(body.expires_in, "expires_in", operation)
  const refreshToken = optionalNonEmptyString(body.refresh_token, "refresh_token", operation)
  const tokenType = optionalNonEmptyString(body.token_type, "token_type", operation)
  const responseScopes = parseScopes(body.scope, operation)
  return {
    accessToken: body.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(responseScopes === undefined ? {} : { scopes: responseScopes }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function positiveSeconds(
  value: unknown,
  field: string,
  operation: "authorization code" | "refresh token"
): number | undefined {
  if (value === undefined) return undefined
  const seconds = typeof value === "string" ? Number(value) : value
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned an invalid ${field} in the ${operation} response.`
    )
  }
  return seconds
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  operation: "authorization code" | "refresh token"
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned an invalid ${field} in the ${operation} response.`
    )
  }
  return value
}

function parseScopes(
  value: unknown,
  operation: "authorization code" | "refresh token"
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned invalid scopes in the ${operation} response.`
    )
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "))
  } catch (error) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned invalid URL-encoded scopes in the ${operation} response.`,
      { cause: error }
    )
  }
  const scopes = decoded.split(/\s+/).filter(Boolean)
  if (scopes.length === 0) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbLinkedin] LinkedIn returned invalid scopes in the ${operation} response.`
    )
  }
  return scopes
}

function providerMessage(body: unknown): string {
  if (!isRecord(body)) return ""
  const code = typeof body.error === "string" ? body.error : undefined
  const description =
    typeof body.error_description === "string" ? body.error_description : undefined
  const message = [code, description].filter(Boolean).join(": ")
  return message ? `: ${message}` : ""
}

function normalizeScopes(scopes: readonly LinkedinOAuthScope[]): readonly LinkedinOAuthScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("[SixbLinkedin] scopes must contain at least one OAuth scope.")
  }
  const normalized = scopes.map((scope) => {
    assertNonEmpty(scope, "OAuth scope")
    if (/\s/.test(scope)) {
      throw new Error("[SixbLinkedin] each OAuth scope must be a single value without whitespace.")
    }
    return scope
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("[SixbLinkedin] scopes must not contain duplicate values.")
  }
  return normalized
}

function nonEmpty(value: string, field: string): string {
  assertNonEmpty(value, field)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
