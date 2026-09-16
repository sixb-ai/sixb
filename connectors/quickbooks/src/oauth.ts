import { type ConnectorOAuth2Authentication, ConnectorOAuthError } from "@sixb/core"
import type { QuickBooksConnectorOptions } from "./types"
import { isRecord, realmId } from "./validation"

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
const SCOPE = "com.intuit.quickbooks.accounting"

export function createQuickBooksOAuth(
  options: QuickBooksConnectorOptions
): ConnectorOAuth2Authentication {
  const authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`

  async function request(url: string, body: BodyInit, signal: AbortSignal, revoke = false) {
    signal.throwIfAborted()
    let response: Response
    let data: unknown
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": revoke ? "application/json" : "application/x-www-form-urlencoded",
        },
        body,
        signal:
          options.timeoutMs === undefined
            ? signal
            : AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
      })
      const text = await response.text()
      try {
        data = text ? JSON.parse(text) : undefined
      } catch {
        data = undefined
      }
    } catch {
      // A token may have rotated even when its response was lost. Never automatically replay.
      throw new ConnectorOAuthError(
        "ambiguous",
        "[SixbQuickBooks] OAuth request outcome is unknown."
      )
    }
    if (revoke && response.status === 400 && isRecord(data) && data.error === "invalid_token")
      return
    if (!response.ok) {
      throw new ConnectorOAuthError(
        response.status === 429 ? "retryable" : response.status >= 500 ? "ambiguous" : "terminal",
        `[SixbQuickBooks] OAuth request rejected (HTTP ${response.status}).`
      )
    }
    return data
  }

  async function exchange(parameters: Record<string, string>, signal: AbortSignal) {
    const data = await request(TOKEN_URL, new URLSearchParams(parameters), signal)
    if (
      !isRecord(data) ||
      typeof data.access_token !== "string" ||
      !data.access_token.trim() ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token.trim() ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer"
    ) {
      throw new ConnectorOAuthError("ambiguous", "[SixbQuickBooks] Invalid OAuth token response.")
    }
    const expiresAt = new Date(Date.now() + data.expires_in * 1000)
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new ConnectorOAuthError("ambiguous", "[SixbQuickBooks] Invalid OAuth expiry.")
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: "Bearer",
      expiresAt,
      scopes: [SCOPE],
    }
  }

  return {
    type: "oauth2",
    pkce: "disabled",
    callbackParameters: ["realmId"],
    authorizationUrl(context, input) {
      const url = new URL("https://appcenter.intuit.com/connect/oauth2")
      url.search = new URLSearchParams({
        client_id: options.clientId,
        response_type: "code",
        scope: SCOPE,
        redirect_uri: context.redirectUri,
        state: input.state,
      }).toString()
      return url
    },
    async exchangeCode(context, input) {
      const id = realmId(input.callbackParameters?.realmId)
      const credentials = await exchange(
        { grant_type: "authorization_code", code: input.code, redirect_uri: context.redirectUri },
        context.signal
      )
      return { ...credentials, authorizationContext: { realmId: id } }
    },
    async refresh(context, credentials) {
      if (!credentials.refreshToken)
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbQuickBooks] Reauthorization required: missing refresh token."
        )
      return {
        ...(await exchange(
          { grant_type: "refresh_token", refresh_token: credentials.refreshToken },
          context.signal
        )),
        authorizationContext: credentials.authorizationContext,
      }
    },
    async revoke(context, credentials) {
      await request(
        REVOKE_URL,
        JSON.stringify({ token: credentials.refreshToken ?? credentials.accessToken }),
        context.signal,
        true
      )
    },
  }
}
