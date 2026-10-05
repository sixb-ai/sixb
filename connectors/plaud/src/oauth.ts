import {
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import type { PlaudConnectorOptions } from "./types"
import { isRecord, nonEmpty, signalFor } from "./validation"

const OAUTH_BASE = "https://mcp.plaud.ai/"

/** Provider mutations are never replayed: a lost response may have consumed a code or token. */
export async function oauthRequest(
  path: "token" | "register",
  body: BodyInit,
  contentType: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  signal.throwIfAborted()
  let response: Response
  try {
    response = await fetch(new URL(path, OAUTH_BASE), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: signalFor(signal, undefined, timeoutMs),
      headers: { Accept: "application/json", "Content-Type": contentType },
      body,
    })
  } catch {
    throw new ConnectorOAuthError("ambiguous", "[SixbPlaud] OAuth request outcome is unknown.")
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ConnectorOAuthError(
      response.status === 429 ? "retryable" : response.status >= 500 ? "ambiguous" : "terminal",
      `[SixbPlaud] OAuth request failed (HTTP ${response.status}).`
    )
  }
  try {
    return await response.json()
  } catch {
    throw new ConnectorOAuthError("ambiguous", "[SixbPlaud] Invalid OAuth JSON response.")
  }
}

export function createPlaudOAuth(options: PlaudConnectorOptions): ConnectorOAuth2Authentication {
  async function exchange(parameters: Record<string, string>, signal: AbortSignal) {
    return normalizeCredentials(
      await oauthRequest(
        "token",
        new URLSearchParams({ client_id: options.clientId, ...parameters }),
        "application/x-www-form-urlencoded",
        options.timeoutMs ?? 30_000,
        signal
      )
    )
  }
  return {
    type: "oauth2",
    pkce: "S256",
    authorizationUrl(context, input) {
      context.signal.throwIfAborted()
      if (!input.codeChallenge || input.codeChallengeMethod !== "S256")
        throw new Error("[SixbPlaud] PKCE S256 is required.")
      const url = new URL("authorize", OAUTH_BASE)
      url.search = new URLSearchParams({
        client_id: options.clientId,
        response_type: "code",
        redirect_uri: context.redirectUri,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
      }).toString()
      return url
    },
    exchangeCode(context, input) {
      return exchange(
        {
          grant_type: "authorization_code",
          code: nonEmpty(input.code, "authorization code"),
          redirect_uri: context.redirectUri,
          code_verifier: nonEmpty(input.codeVerifier ?? "", "PKCE verifier"),
        },
        context.signal
      )
    },
    refresh(context, credentials) {
      if (!credentials.refreshToken)
        throw new ConnectorOAuthError("terminal", "[SixbPlaud] Missing refresh token. Reauthorize.")
      return exchange(
        { grant_type: "refresh_token", refresh_token: credentials.refreshToken },
        context.signal
      )
    },
  }
}

function normalizeCredentials(data: unknown): ConnectorOAuthCredentials {
  if (
    !isRecord(data) ||
    typeof data.access_token !== "string" ||
    !data.access_token.trim() ||
    (data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" || !data.refresh_token.trim())) ||
    (data.token_type !== undefined &&
      (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) ||
    (data.expires_in !== undefined &&
      (typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0))
  )
    throw new ConnectorOAuthError("ambiguous", "[SixbPlaud] Invalid OAuth token response.")
  let expiresAt: Date | undefined
  if (typeof data.expires_in === "number") {
    expiresAt = new Date(Date.now() + data.expires_in * 1000)
    if (!Number.isFinite(expiresAt.getTime()))
      throw new ConnectorOAuthError("ambiguous", "[SixbPlaud] Invalid OAuth expiry.")
  } else {
    // A JWT exp is only a refresh scheduling hint; Plaud authenticates the token.
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(data.access_token.split(".")[1] ?? "", "base64url").toString()
      )
      if (isRecord(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
        const date = new Date(payload.exp * 1000)
        if (Number.isFinite(date.getTime())) expiresAt = date
      }
    } catch {
      /* Opaque tokens refresh after a 401. */
    }
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    tokenType: "Bearer",
    ...(expiresAt ? { expiresAt } : {}),
  }
}
