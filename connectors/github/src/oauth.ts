import {
  type ConnectorAccountCandidate,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
} from "@sixb/core"
import { githubWebOrigin } from "./http"
import type { GitHubOAuthOptions } from "./types/options"

const GITHUB_API_VERSION = "2022-11-28"
const OFFLINE_ACCESS_SCOPE = "offline_access"

type TokenOperation = "authorization code" | "refresh token"

export interface GitHubOAuth {
  readonly authentication: ConnectorOAuth2Authentication
  discoverAccounts(
    context: ConnectorContext,
    credentials: ConnectorOAuthCredentials
  ): Promise<readonly ConnectorAccountCandidate[]>
}

export function createGitHubOAuth(options: GitHubOAuthOptions, apiBaseUrl: URL): GitHubOAuth {
  const clientId = parseClientId(options.clientId, "oauth.clientId")
  const clientSecret = parseSecret(options.clientSecret, "oauth.clientSecret")
  const webOrigin =
    options.webBaseUrl === undefined
      ? githubWebOrigin(apiBaseUrl)
      : parseOrigin(options.webBaseUrl, "oauth.webBaseUrl")
  const pkce = parsePkce(options.pkce)
  const configuredScopes = parseScopes(options.scopes)
  const scopeParam =
    configuredScopes === undefined ? OFFLINE_ACCESS_SCOPE : configuredScopes.join(" ")
  const requiredScopes = (configuredScopes ?? []).filter((scope) => scope !== OFFLINE_ACCESS_SCOPE)
  const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
  const apiBase = ensureTrailingSlash(apiBaseUrl)

  return {
    authentication: {
      type: "oauth2",
      pkce,
      authorizationUrl(context, input) {
        const url = new URL("/login/oauth/authorize", webOrigin)
        url.searchParams.set("client_id", clientId)
        url.searchParams.set("redirect_uri", context.redirectUri)
        if (scopeParam) url.searchParams.set("scope", scopeParam)
        url.searchParams.set("state", input.state)
        url.searchParams.set("prompt", "select_account")
        if (input.codeChallenge) {
          url.searchParams.set("code_challenge", input.codeChallenge)
          url.searchParams.set("code_challenge_method", input.codeChallengeMethod ?? "S256")
        }
        return url
      },

      async exchangeCode(context, input) {
        const credentials = tokenCredentials(
          await requestToken(
            webOrigin,
            {
              client_id: clientId,
              client_secret: clientSecret,
              code: input.code,
              redirect_uri: context.redirectUri,
              ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
            },
            context.signal,
            "authorization code"
          ),
          "authorization code"
        )
        if (credentials.expiresAt !== undefined && !credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbGitHub] GitHub issued an expiring access token without a refresh token."
          )
        }
        if (requiredScopes.length > 0) {
          const granted = new Set(credentials.scopes ?? [])
          const missing = requiredScopes.filter((scope) => !granted.has(scope))
          if (missing.length > 0) {
            throw new ConnectorOAuthError(
              "terminal",
              `[SixbGitHub] The GitHub account did not grant ${missing.join(", ")}. Connect again and allow every requested permission.`
            )
          }
        }
        return credentials
      },

      async refresh(context, credentials) {
        if (!credentials.refreshToken) {
          throw new ConnectorOAuthError(
            "terminal",
            "[SixbGitHub] The connection has no refresh token; reauthorization is required."
          )
        }
        return tokenCredentials(
          await requestToken(
            webOrigin,
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

      async revoke(context, credentials) {
        let response: Response
        try {
          response = await fetch(
            new URL(`applications/${encodeURIComponent(clientId)}/grant`, apiBase),
            {
              method: "DELETE",
              redirect: "error",
              signal: context.signal,
              headers: {
                Authorization: basicAuth,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ access_token: credentials.accessToken }),
            }
          )
        } catch (error) {
          throw new ConnectorOAuthError(
            "retryable",
            "[SixbGitHub] GitHub grant revocation failed.",
            { cause: error }
          )
        }
        // 404 means the grant was already revoked on GitHub.
        if (response.status === 204 || response.status === 404) return
        throw new ConnectorOAuthError(
          response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
          `[SixbGitHub] GitHub rejected grant revocation (${response.status}).`
        )
      },
    },

    async discoverAccounts(context, credentials) {
      let response: Response
      let body: unknown
      try {
        response = await fetch(new URL("user", apiBase), {
          redirect: "error",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credentials.accessToken}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
          signal: context.signal,
        })
        body = await readJsonSafe(response)
      } catch (error) {
        throw new ConnectorOAuthError("retryable", "[SixbGitHub] GitHub account lookup failed.", {
          cause: error,
        })
      }
      if (!response.ok) {
        throw new ConnectorOAuthError(
          response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
          `[SixbGitHub] GitHub rejected the account lookup (${response.status}).`
        )
      }
      return [githubAccount(body)]
    },
  }
}

async function requestToken(
  webOrigin: string,
  parameters: Readonly<Record<string, string>>,
  signal: AbortSignal,
  operation: TokenOperation
): Promise<unknown> {
  const unknownOutcome = operation === "refresh token" ? "retryable" : "ambiguous"
  let response: Response
  let body: unknown
  try {
    response = await fetch(new URL("/login/oauth/access_token", webOrigin), {
      method: "POST",
      redirect: "error",
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
      `[SixbGitHub] GitHub ${operation} exchange outcome is unknown.`,
      { cause: error }
    )
  }
  const errorCode = isRecord(body) ? optionalString(body.error) : undefined
  if (!response.ok || errorCode !== undefined) {
    throw new ConnectorOAuthError(
      rejectionKind(response.status, errorCode, operation),
      `[SixbGitHub] GitHub rejected the ${operation} exchange (${response.status})${providerDetail(body)}.`
    )
  }
  return body
}

function rejectionKind(
  status: number,
  errorCode: string | undefined,
  operation: TokenOperation
): ConnectorOAuthErrorKind {
  if (operation === "refresh token") {
    // Only a dead refresh token ends the grant; configuration or upstream errors leave user grants intact.
    return errorCode === "bad_refresh_token" || errorCode === "invalid_grant"
      ? "terminal"
      : "retryable"
  }
  if (status === 429) return "retryable"
  if (status >= 500) return "ambiguous"
  return "terminal"
}

function tokenCredentials(body: unknown, operation: TokenOperation): ConnectorOAuthCredentials {
  const invalid = () =>
    new ConnectorOAuthError(
      operation === "refresh token" ? "retryable" : "ambiguous",
      `[SixbGitHub] GitHub returned an invalid ${operation} response.`
    )
  if (!isRecord(body)) throw invalid()
  const accessToken = optionalString(body.access_token)
  if (accessToken === undefined || /[\r\n]/.test(accessToken)) throw invalid()

  const expiresIn = body.expires_in
  if (
    expiresIn !== undefined &&
    (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
  ) {
    throw invalid()
  }
  const refreshToken = optionalString(body.refresh_token)
  if (refreshToken !== undefined && /[\r\n]/.test(refreshToken)) throw invalid()
  const tokenType = optionalString(body.token_type)
  const parsedScopes =
    typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean) : undefined
  const scopes = parsedScopes && parsedScopes.length > 0 ? parsedScopes : undefined

  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
  }
}

function githubAccount(body: unknown): ConnectorAccountCandidate {
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.id) ||
    Number(body.id) <= 0 ||
    typeof body.login !== "string" ||
    !body.login.trim()
  ) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbGitHub] GitHub returned an invalid user profile."
    )
  }
  const login = body.login.trim()
  const name = optionalString(body.name)
  const avatarUrl = optionalString(body.avatar_url)
  return {
    id: String(body.id),
    label: login,
    ...(name === undefined || name === login ? {} : { description: name }),
    ...(avatarUrl === undefined || !isHttpsUrl(avatarUrl) ? {} : { avatarUrl }),
  }
}

function parseClientId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value.trim())) {
    throw new Error(`[SixbGitHub] ${field} must be a non-empty client identifier.`)
  }
  return value.trim()
}

function parseSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`[SixbGitHub] ${field} must not be empty.`)
  }
  return value
}

function parseOrigin(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbGitHub] ${field} must be a valid URL.`)
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`[SixbGitHub] ${field} must be a credential-free origin.`)
  }
  return url.origin
}

function parsePkce(value: "S256" | "disabled" | undefined): "S256" | "disabled" {
  if (value === undefined || value === "S256" || value === "disabled") return value ?? "S256"
  throw new Error("[SixbGitHub] oauth.pkce must be \"S256\" or \"disabled\".")
}

function parseScopes(scopes: readonly string[] | undefined): readonly string[] | undefined {
  if (scopes === undefined) return undefined
  if (
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    throw new Error("[SixbGitHub] oauth.scopes must be an array of non-empty strings.")
  }
  return [...new Set(scopes.map((scope) => scope.trim()))]
}

function ensureTrailingSlash(url: URL): URL {
  return url.pathname.endsWith("/") ? url : new URL(`${url.href}/`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function providerDetail(body: unknown): string {
  if (!isRecord(body)) return ""
  const description = optionalString(body.error_description)
  const code = optionalString(body.error)
  const detail = description ?? code
  return detail ? `: ${detail.replace(/\.+$/, "")}` : ""
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
