import type { RestClient, RestRequestInit } from "@sixb/connector-rest"
import type { ConnectorTokenSource } from "@sixb/core"
import { isInvalidGrantError, parseMetaBody, parseMetaGraphError } from "./http"

/** A fixed token (system user) or a Sixb-managed connection token (OAuth). */
export type MetaAccessTokenSource = string | ConnectorTokenSource

/**
 * Authorize each request that does not carry its own token.
 *
 * A managed token that Meta rejects for the whole sign-in is reported to Sixb. Facebook Login
 * grants carry no refresh token, so Sixb marks the grant, and with it every Page connected from
 * it, for reauthorization, and the next token read throws.
 */
export function withAccessToken(
  http: RestClient,
  scheme: "Bearer" | "OAuth",
  source: MetaAccessTokenSource
): RestClient {
  async function send(
    init: RestRequestInit | undefined,
    call: (init: RestRequestInit) => Promise<Response>
  ): Promise<Response> {
    // A caller-supplied token (`{ accessToken }` scopes, batch overrides) is not ours to judge.
    if (new Headers(init?.headers).has("authorization")) return call(init ?? {})

    if (typeof source === "string") return call(authorized(init, `${scheme} ${source}`))

    const token = await source.get()
    const response = await call(authorized(init, `${scheme} ${token.accessToken}`))
    if (!(await rejectsGrant(response))) return response

    token.invalidate()
    try {
      // Throws `connector.authorization_required` once Sixb has marked the connection.
      await source.get()
    } catch (error) {
      await response.body?.cancel()
      throw error
    }
    // The connection was reauthorized meanwhile: the caller can retry with the new token.
    return response
  }

  return {
    request: (path, init, options) => send(init, (next) => http.request(path, next, options)),
    get: (path, init, options) => send(init, (next) => http.get(path, next, options)),
    post: (path, body, init, options) => send(init, (next) => http.post(path, body, next, options)),
  }
}

function authorized(init: RestRequestInit | undefined, authorization: string): RestRequestInit {
  const headers = new Headers(init?.headers)
  headers.set("authorization", authorization)
  return { ...init, headers }
}

async function rejectsGrant(response: Response): Promise<boolean> {
  if (response.ok) return false
  let body: string
  try {
    body = await response.clone().text()
  } catch {
    // Unreadable here means unreadable for the caller too, which reports it.
    return false
  }
  return isInvalidGrantError(parseMetaGraphError(parseMetaBody(body)))
}
