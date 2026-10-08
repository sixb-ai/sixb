import {
  type ConnectorAccountCandidate,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
} from "@sixb/core"
import { GoogleAuthError } from "../errors"
import { isRecord } from "../guards"
import { formatOAuthError, readJsonSafe } from "./token-response"
import type { GoogleOAuthOptions } from "./types"

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email"

/** Google reports the short identity scopes under their full names in a token response. */
const SCOPE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["email", EMAIL_SCOPE],
  ["profile", "https://www.googleapis.com/auth/userinfo.profile"],
])
/** Account discovery reads the OpenID subject and email of the consenting account. */
const IDENTITY_SCOPES = ["openid", EMAIL_SCOPE]
const HOSTED_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

type TokenOperation = "authorization code" | "refresh token"

export interface GoogleOAuth {
  readonly authentication: ConnectorOAuth2Authentication
  discoverAccounts(
    context: ConnectorContext,
    credentials: ConnectorOAuthCredentials
  ): Promise<readonly ConnectorAccountCandidate[]>
}

/**
 * Google's confidential web-server flow for Sixb-managed connections.
 *
 * There is deliberately no `revoke`. Google revocation ends the account's whole grant to the OAuth
 * client, not one token, while Sixb revokes an authorization when a newer one replaces it.
 * Reconnecting the same Google account would then invalidate the replacement as well. Disconnecting
 * deletes the stored tokens; the account owner removes the grant itself from their Google account.
 */
export function createGoogleOAuth(options: GoogleOAuthOptions): GoogleOAuth {
  const clientId = nonEmpty(options.clientId, "oauth.clientId")
  const clientSecret = nonEmpty(options.clientSecret, "oauth.clientSecret")
  const scopes = requestedScopes(options.scopes)
  const hostedDomain =
    options.hostedDomain === undefined ? undefined : normalizeHostedDomain(options.hostedDomain)

  return {
    authentication: {
      type: "oauth2",
      authorizationUrl(context, input) {
        const url = new URL(AUTHORIZATION_URL)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("client_id", clientId)
        url.searchParams.set("redirect_uri", context.redirectUri)
        url.searchParams.set("scope", scopes.join(" "))
        url.searchParams.set("state", input.state)
        // Google issues a refresh token only for offline access granted on a consent screen. An
        // account that already granted this client skips consent, so a reconnect would lack one.
        url.searchParams.set("access_type", "offline")
        url.searchParams.set("prompt", "select_account consent")
        if (input.codeChallenge) {
          url.searchParams.set("code_challenge", input.codeChallenge)
          url.searchParams.set("code_challenge_method", input.codeChallengeMethod ?? "S256")
        }
        if (hostedDomain) url.searchParams.set("hd", hostedDomain)
        return url
      },

      async exchangeCode(context, input) {
        const credentials = tokenCredentials(
          await requestToken(
            {
              grant_type: "authorization_code",
              code: input.code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: context.redirectUri,
              ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
            },
            context.signal,
            "authorization code"
          ),
          "authorization code"
        )
        if (!credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbGoogle] Google did not issue a refresh token for offline access."
          )
        }
        // Users can untick individual scopes on Google's consent screen.
        const missing = missingScopes(scopes, credentials.scopes)
        if (missing.length > 0) {
          throw new ConnectorOAuthError(
            "terminal",
            `[SixbGoogle] The Google account did not grant ${missing.join(", ")}. Connect again and allow every requested permission.`
          )
        }
        return credentials
      },

      async refresh(context, credentials) {
        if (!credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbGoogle] The connection has no refresh token; reauthorization is required."
          )
        }
        return tokenCredentials(
          await requestToken(
            {
              grant_type: "refresh_token",
              refresh_token: credentials.refreshToken,
              client_id: clientId,
              client_secret: clientSecret,
            },
            context.signal,
            "refresh token"
          ),
          "refresh token"
        )
      },
    },

    async discoverAccounts(context, credentials) {
      let response: Response
      let body: unknown
      try {
        response = await fetch(USERINFO_URL, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credentials.accessToken}`,
          },
          signal: context.signal,
        })
        body = await readJsonSafe(response)
      } catch (error) {
        throw new ConnectorOAuthError("retryable", "[SixbGoogle] Google account lookup failed.", {
          cause: error,
        })
      }
      if (!response.ok) {
        throw new ConnectorOAuthError(
          response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
          `[SixbGoogle] Google rejected the account lookup (${response.status})${providerDetail(body)}.`
        )
      }
      return [googleAccount(body, hostedDomain)]
    },
  }
}

async function requestToken(
  parameters: Readonly<Record<string, string>>,
  signal: AbortSignal,
  operation: TokenOperation
): Promise<unknown> {
  // A refresh never changes a Google grant, so a lost refresh response is safe to retry. A lost
  // code exchange may have consumed the one-use code.
  const unknownOutcome = operation === "refresh token" ? "retryable" : "ambiguous"
  let response: Response
  let body: unknown
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
      signal,
    })
    body = await readJsonSafe(response)
  } catch (error) {
    throw new ConnectorOAuthError(
      unknownOutcome,
      `[SixbGoogle] Google ${operation} exchange outcome is unknown.`,
      { cause: error }
    )
  }
  if (!response.ok) {
    throw new ConnectorOAuthError(
      rejectionKind(response.status, body, operation),
      `[SixbGoogle] Google rejected the ${operation} exchange (${response.status})${providerDetail(body)}.`
    )
  }
  return body
}

function rejectionKind(
  status: number,
  body: unknown,
  operation: TokenOperation
): ConnectorOAuthErrorKind {
  if (operation === "refresh token") {
    // Only a dead grant needs reauthorization. A configuration error such as `invalid_client`
    // leaves every grant intact, and calling it terminal would disconnect every account at once.
    const error = isRecord(body) ? body.error : undefined
    return error === "invalid_grant" || error === "admin_policy_enforced" ? "terminal" : "retryable"
  }
  return status === 429 ? "retryable" : status < 500 ? "terminal" : "ambiguous"
}

function tokenCredentials(body: unknown, operation: TokenOperation): ConnectorOAuthCredentials {
  const invalid = () =>
    new ConnectorOAuthError(
      operation === "refresh token" ? "retryable" : "ambiguous",
      `[SixbGoogle] Google returned an invalid ${operation} response.`
    )
  if (!isRecord(body)) throw invalid()
  const accessToken = optionalString(body.access_token)
  if (accessToken === undefined) throw invalid()

  const expiresIn = body.expires_in
  if (
    expiresIn !== undefined &&
    (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
  ) {
    throw invalid()
  }
  const refreshToken = optionalString(body.refresh_token)
  const scopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : undefined
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
  }
}

function googleAccount(body: unknown, hostedDomain: string | undefined): ConnectorAccountCandidate {
  const subject = isRecord(body) ? optionalString(body.sub) : undefined
  if (!isRecord(body) || subject === undefined) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbGoogle] Google returned an account profile without a subject."
    )
  }
  // `hd` is Google's assertion of the Workspace domain; the `hd` request parameter is only a hint.
  if (hostedDomain !== undefined && optionalString(body.hd)?.toLowerCase() !== hostedDomain) {
    throw new ConnectorOAuthError(
      "terminal",
      `[SixbGoogle] The Google account is not part of the ${hostedDomain} Workspace domain.`
    )
  }

  const email = optionalString(body.email)
  const name = optionalString(body.name)
  const picture = optionalString(body.picture)
  const label = email ?? name ?? subject
  return {
    id: subject,
    label,
    ...(name === undefined || name === label ? {} : { description: name }),
    ...(picture === undefined || !isHttpsUrl(picture) ? {} : { avatarUrl: picture }),
  }
}

function missingScopes(
  requested: readonly string[],
  granted: readonly string[] | undefined
): readonly string[] {
  // An omitted `scope` means the requested scopes were granted as-is (RFC 6749 §5.1).
  if (granted === undefined) return []
  const grantedScopes = new Set(granted.map(canonicalScope))
  return requested.filter((scope) => !grantedScopes.has(scope))
}

function requestedScopes(scopes: readonly string[]): readonly string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    throw new GoogleAuthError("at least one non-empty scope is required for OAuth auth.")
  }
  return [...new Set([...scopes.map(canonicalScope), ...IDENTITY_SCOPES])]
}

function canonicalScope(scope: string): string {
  const trimmed = scope.trim()
  return SCOPE_ALIASES.get(trimmed) ?? trimmed
}

function normalizeHostedDomain(value: string): string {
  const domain = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!HOSTED_DOMAIN.test(domain)) {
    throw new GoogleAuthError("oauth.hostedDomain must be a domain name such as example.com.")
  }
  return domain
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GoogleAuthError(`${field} must not be empty.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function providerDetail(body: unknown): string {
  const detail = isRecord(body) ? formatOAuthError(body) : null
  // Callers end the sentence; Google's descriptions often already do.
  return detail ? `: ${detail.replace(/\.+$/, "")}` : ""
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:"
}
