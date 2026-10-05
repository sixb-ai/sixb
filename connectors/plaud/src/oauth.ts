import type { ConnectorTokenSource } from "@sixb/core"
import { PlaudApiError, PlaudAuthError } from "./errors"
import { resolveTokenStore, validateTokens } from "./token-store"
import type { PlaudConnectionOptions, PlaudTokens } from "./types"
import { integer, isRecord, signalFor } from "./validation"

export const API_BASE = "https://platform.plaud.ai/developer/api/"
// Public native client configuration shipped by Plaud, not a private client secret.
export const NATIVE_CLIENT_ID = "client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674"
export const NATIVE_REDIRECT_URI = "http://localhost:8199/auth/callback"

export function routingHeaders(options: PlaudConnectionOptions): Record<string, string> {
  return options.region ? { "x-pld-region": options.region } : {}
}

/** No retries: a lost token response can have consumed a rotating refresh token/code. */
export async function tokenRequest(
  path: string,
  parameters: Record<string, string>,
  options: PlaudConnectionOptions,
  signal: AbortSignal,
  basic?: string,
  previousRefreshToken?: string
): Promise<PlaudTokens> {
  const response = await fetch(new URL(path, API_BASE), {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    signal: signalFor(signal, undefined, options.timeoutMs ?? 30_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...routingHeaders(options),
      ...(basic ? { Authorization: `Basic ${basic}` } : {}),
    },
    body: new URLSearchParams(parameters),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new PlaudApiError(response.status, "OAuth")
  }
  const data: unknown = await response.json()
  if (!isRecord(data))
    throw new PlaudAuthError("refresh_uncertain", "Invalid OAuth response. Reauthorize.")
  let expiresAt: number | undefined
  if (data.expires_in !== undefined) {
    if (
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new PlaudAuthError("refresh_uncertain", "Invalid OAuth expiry. Reauthorize.")
    expiresAt = Date.now() + data.expires_in * 1000
  }
  return validateTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? previousRefreshToken,
    token_type: data.token_type ?? "Bearer",
    expires_at: expiresAt,
  })
}

function expiry(tokens: PlaudTokens): number | undefined {
  if (tokens.expires_at !== undefined) return tokens.expires_at
  // This is only a scheduling hint; Plaud, not this client, authenticates the JWT.
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString()
    )
    if (isRecord(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp))
      return payload.exp * 1000
  } catch {
    /* Opaque access tokens refresh after a 401. */
  }
  return undefined
}

export function createTokenSource(
  options: PlaudConnectionOptions,
  signal: AbortSignal
): ConnectorTokenSource {
  integer(options.timeoutMs ?? 30_000, 1, "timeoutMs")
  const store = resolveTokenStore(options)
  let rejectedToken: string | undefined
  let currentToken: string | undefined
  return {
    get() {
      return store.withLock(async () => {
        signal.throwIfAborted()
        let tokens = await store.load()
        if (!tokens)
          throw new PlaudAuthError(
            "login_required",
            "Run loginPlaud before using the connector, or provide an authorized MCP tokenFile."
          )
        validateTokens(tokens)
        if (tokens.refresh_pending)
          throw new PlaudAuthError(
            "refresh_uncertain",
            "A previous token refresh has an uncertain outcome. Reauthorize with loginPlaud; the old refresh token will not be replayed."
          )
        const expiresAt = expiry(tokens)
        if (
          rejectedToken === tokens.access_token ||
          (expiresAt !== undefined && expiresAt <= Date.now() + 60_000)
        ) {
          if (!tokens.refresh_token)
            throw new PlaudAuthError(
              "login_required",
              "The access token expired or was rejected and no refresh token is available. Run loginPlaud."
            )
          const previous = tokens
          // Persist intent before sending the refresh. Survives a crash or a failed save after rotation.
          await store.save({ ...previous, refresh_pending: true })
          try {
            tokens = await tokenRequest(
              "oauth/third-party/access-token/refresh",
              { refresh_token: previous.refresh_token! },
              options,
              signal,
              undefined,
              previous.refresh_token
            )
            await store.save(tokens)
          } catch (error) {
            if (error instanceof PlaudApiError && error.status === 429) {
              await store.save(previous)
              throw error
            }
            throw new PlaudAuthError(
              error instanceof PlaudApiError && [400, 401, 403].includes(error.status)
                ? "rejected"
                : "refresh_uncertain",
              "Token refresh did not complete safely. Run loginPlaud to reauthorize."
            )
          }
          rejectedToken = undefined
        }
        const accessToken = tokens.access_token
        currentToken = accessToken
        return {
          accessToken,
          tokenType: "Bearer",
          invalidate() {
            if (currentToken === accessToken) rejectedToken = accessToken
          },
        }
      }, signal)
    },
  }
}
