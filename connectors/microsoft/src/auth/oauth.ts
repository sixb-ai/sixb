import {
  type ConnectorAccountCandidate,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
} from "@sixb/core"
import { MicrosoftConfigurationError } from "../errors"
import { isRecord } from "../guards"
import { nonEmpty, segment } from "../validation"
import { assertSpecificTenant } from "./tenant"
import type { MicrosoftOAuthOptions } from "./types"

/**
 * `openid profile` return an ID token naming the person; `offline_access` returns a refresh token.
 */
const IDENTITY_SCOPES = ["openid", "profile", "offline_access"]
const GRAPH_RESOURCE = "https://graph.microsoft.com/"

type TokenOperation = "authorization code" | "refresh token"

export interface MicrosoftOAuth {
  readonly authentication: ConnectorOAuth2Authentication
  discoverAccounts(
    context: ConnectorContext,
    credentials: ConnectorOAuthCredentials
  ): readonly ConnectorAccountCandidate[]
}

/**
 * Entra's authorization code flow for a confidential web app, acting as the person who signs in.
 *
 * There is deliberately no `revoke`: Entra has no endpoint that lets an app revoke one person's
 * refresh token. Disconnecting deletes the stored grant.
 */
export function createMicrosoftOAuth(
  options: MicrosoftOAuthOptions,
  timeoutMs: number
): MicrosoftOAuth {
  const tenantId = assertSpecificTenant(nonEmpty(options.tenantId, "oauth.tenantId"))
  const clientId = nonEmpty(options.clientId, "oauth.clientId")
  const clientSecret = nonEmpty(options.clientSecret, "oauth.clientSecret")
  const scopes = requestedScopes(options.scopes)
  const endpoint = `https://login.microsoftonline.com/${segment(tenantId, "tenantId")}/oauth2/v2.0`
  const signalFor = (context: ConnectorContext) =>
    AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])

  const requestToken = async (
    parameters: Readonly<Record<string, string>>,
    context: ConnectorContext,
    operation: TokenOperation
  ): Promise<Record<string, unknown>> => {
    // A refresh can be repeated safely. A code exchange whose response was lost may have used up
    // the one-time code.
    const unknownOutcome = operation === "refresh token" ? "retryable" : "ambiguous"
    let response: Response
    let body: unknown
    try {
      response = await fetch(`${endpoint}/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          ...parameters,
        }),
        redirect: "error",
        signal: signalFor(context),
      })
      body = await readJson(response)
    } catch (error) {
      throw new ConnectorOAuthError(
        unknownOutcome,
        `[SixbMicrosoft] Microsoft ${operation} exchange outcome is unknown.`,
        { cause: error }
      )
    }
    if (!response.ok || !isRecord(body)) {
      throw new ConnectorOAuthError(
        response.ok ? unknownOutcome : rejectionKind(response.status, body, operation),
        `[SixbMicrosoft] Microsoft rejected the ${operation} exchange (${response.status}${entraErrorCode(body)}).`
      )
    }
    return body
  }

  return {
    authentication: {
      type: "oauth2",
      authorizationUrl(context, input) {
        const url = new URL(`${endpoint}/authorize`)
        url.searchParams.set("client_id", clientId)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("response_mode", "query")
        url.searchParams.set("redirect_uri", context.redirectUri)
        url.searchParams.set("scope", scopes.join(" "))
        url.searchParams.set("state", input.state)
        // Someone signed in to several Microsoft accounts picks the one to connect.
        url.searchParams.set("prompt", "select_account")
        if (input.codeChallenge) {
          url.searchParams.set("code_challenge", input.codeChallenge)
          url.searchParams.set("code_challenge_method", input.codeChallengeMethod ?? "S256")
        }
        return url
      },

      async exchangeCode(context, input) {
        const body = await requestToken(
          {
            grant_type: "authorization_code",
            code: input.code,
            redirect_uri: context.redirectUri,
            scope: scopes.join(" "),
            ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
          },
          context,
          "authorization code"
        )
        const credentials = {
          ...tokenCredentials(body, "authorization code"),
          authorizationContext: signedInAccount(body.id_token),
        }
        if (!credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbMicrosoft] Microsoft did not issue a refresh token; offline_access was not granted."
          )
        }
        const missing = missingScopes(scopes, credentials.scopes)
        if (missing.length > 0) {
          throw new ConnectorOAuthError(
            "terminal",
            `[SixbMicrosoft] The Microsoft account was not granted ${missing.join(", ")}. An administrator may need to consent for the tenant.`
          )
        }
        return credentials
      },

      async refresh(context, credentials) {
        if (!credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbMicrosoft] The connection has no refresh token; reconnecting is required."
          )
        }
        const refreshed = tokenCredentials(
          await requestToken(
            {
              grant_type: "refresh_token",
              refresh_token: credentials.refreshToken,
              scope: scopes.join(" "),
            },
            context,
            "refresh token"
          ),
          "refresh token"
        )
        // Entra issues a new refresh token on every refresh; keep the old one only if it doesn't.
        return { ...refreshed, refreshToken: refreshed.refreshToken ?? credentials.refreshToken }
      },
    },

    discoverAccounts(_context, credentials) {
      return [microsoftAccount(credentials.authorizationContext)]
    },
  }
}

function rejectionKind(
  status: number,
  body: unknown,
  operation: TokenOperation
): ConnectorOAuthErrorKind {
  if (operation === "refresh token") {
    // Only a grant the person has to renew needs reconnecting: revoked, expired, or held back by
    // a sign-in policy. A configuration error such as `invalid_client` leaves every grant intact,
    // and calling it terminal would disconnect every account at once.
    const error = isRecord(body) ? body.error : undefined
    return error === "invalid_grant" || error === "interaction_required" ? "terminal" : "retryable"
  }
  return status === 429 ? "retryable" : status < 500 ? "terminal" : "ambiguous"
}

function tokenCredentials(
  body: Record<string, unknown>,
  operation: TokenOperation
): ConnectorOAuthCredentials {
  const accessToken = optionalString(body.access_token)
  const expiresIn = body.expires_in
  if (
    accessToken === undefined ||
    (expiresIn !== undefined &&
      (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0))
  ) {
    throw new ConnectorOAuthError(
      operation === "refresh token" ? "retryable" : "ambiguous",
      `[SixbMicrosoft] Microsoft returned an invalid ${operation} response.`
    )
  }
  const refreshToken = optionalString(body.refresh_token)
  const scopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : undefined
  return {
    accessToken,
    tokenType: "Bearer",
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
  }
}

/**
 * The person who signed in, from the ID token the code exchange returned. It came straight from
 * the tenant's token endpoint over TLS, which OpenID Connect accepts in place of a signature check.
 */
function signedInAccount(idToken: unknown): {
  oid: string
  preferredUsername: string
  name?: string
} {
  const claims = typeof idToken === "string" ? jwtClaims(idToken) : undefined
  const oid = optionalString(claims?.oid)
  const preferredUsername = optionalString(claims?.preferred_username)
  if (oid === undefined || preferredUsername === undefined) {
    throw new ConnectorOAuthError(
      "ambiguous",
      "[SixbMicrosoft] Microsoft did not return an ID token naming the account."
    )
  }
  const name = optionalString(claims?.name)
  return { oid, preferredUsername, ...(name === undefined ? {} : { name }) }
}

/** The account is the person's Entra object id, labelled with the name they sign in with. */
function microsoftAccount(context: unknown): ConnectorAccountCandidate {
  const oid = isRecord(context) ? optionalString(context.oid) : undefined
  const label = isRecord(context) ? optionalString(context.preferredUsername) : undefined
  if (!isRecord(context) || oid === undefined || label === undefined) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbMicrosoft] The grant does not name its account."
    )
  }
  const name = optionalString(context.name)
  return { id: oid, label, ...(name === undefined || name === label ? {} : { description: name }) }
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
    )
    return isRecord(claims) ? claims : undefined
  } catch {
    return undefined
  }
}

function missingScopes(
  requested: readonly string[],
  granted: readonly string[] | undefined
): readonly string[] {
  // An omitted `scope` means the requested scopes were granted as-is (RFC 6749 §5.1). Entra never
  // echoes the identity scopes, so only Graph permissions are compared.
  if (granted === undefined) return []
  const grantedScopes = new Set(granted.map(canonicalScope))
  return requested.filter(
    (scope) => !IDENTITY_SCOPES.includes(scope) && !grantedScopes.has(canonicalScope(scope))
  )
}

function requestedScopes(scopes: readonly string[]): readonly string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    throw new MicrosoftConfigurationError(
      "oauth.scopes must list at least one delegated Microsoft Graph permission, such as Mail.Read."
    )
  }
  if (scopes.some((scope) => scope.trim().endsWith("/.default"))) {
    throw new MicrosoftConfigurationError(
      "oauth.scopes cannot use .default; list the delegated permissions by name."
    )
  }
  return [...new Set([...scopes.map((scope) => scope.trim()), ...IDENTITY_SCOPES])]
}

/** Entra reports Graph permissions with or without the resource prefix, in any case. */
function canonicalScope(scope: string): string {
  const trimmed = scope.trim()
  return (
    trimmed.toLowerCase().startsWith(GRAPH_RESOURCE)
      ? trimmed.slice(GRAPH_RESOURCE.length)
      : trimmed
  ).toLowerCase()
}

/** Only Entra's error code and AADSTS number: descriptions can echo request details. */
function entraErrorCode(body: unknown): string {
  if (!isRecord(body) || typeof body.error !== "string") return ""
  const codes = Array.isArray(body.error_codes)
    ? body.error_codes.filter((code): code is number => typeof code === "number")
    : []
  return ` ${body.error}${codes.length > 0 ? `, AADSTS${codes[0]}` : ""}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}
