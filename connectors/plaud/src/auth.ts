import { ConnectorOAuthError } from "@sixb/core"
import { oauthRequest } from "./oauth"
import type { PlaudClientRegistration, PlaudClientRegistrationOptions } from "./types"
import { integer, isRecord, nonEmpty } from "./validation"

export type { PlaudClientRegistration, PlaudClientRegistrationOptions } from "./types"

/** Register once per deployment, then pass the returned clientId to plaud(). No user tokens. */
export async function registerPlaudClient(
  options: PlaudClientRegistrationOptions
): Promise<PlaudClientRegistration> {
  const timeoutMs = integer(options.timeoutMs ?? 30_000, 1, "timeoutMs")
  const clientName = nonEmpty(options.clientName ?? "Sixb", "clientName")
  if (clientName.length > 64)
    throw new Error("[SixbPlaud] clientName must be at most 64 characters.")
  // Plaud's signed registration binds at most four hosts, each at most 64 characters.
  if (
    !Array.isArray(options.redirectUris) ||
    options.redirectUris.length < 1 ||
    options.redirectUris.length > 4
  )
    throw new Error("[SixbPlaud] Supply between one and four redirectUris.")
  const redirectUris = options.redirectUris.map((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error("[SixbPlaud] Invalid redirect URI.")
    }
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash ||
      url.host.length > 64
    )
      throw new Error(
        "[SixbPlaud] Redirect URIs require HTTPS (HTTP loopback is allowed), a host of at most 64 characters, and no credentials or fragment."
      )
    return url.href
  })
  const response = await oauthRequest(
    "register",
    JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    "application/json",
    timeoutMs,
    options.signal ?? new AbortController().signal
  )
  const registeredUris = isRecord(response) ? response.redirect_uris : undefined
  if (
    !isRecord(response) ||
    typeof response.client_id !== "string" ||
    !response.client_id.trim() ||
    response.token_endpoint_auth_method !== "none" ||
    !Array.isArray(registeredUris) ||
    registeredUris.length !== redirectUris.length ||
    !redirectUris.every((uri) => registeredUris.includes(uri))
  )
    throw new ConnectorOAuthError("ambiguous", "[SixbPlaud] Invalid client registration response.")
  return { clientId: response.client_id, redirectUris }
}
