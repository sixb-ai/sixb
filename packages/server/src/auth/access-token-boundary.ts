import { type AuthenticatedRequestAuthSession, isCsrfExemptMethod } from "@sixb/core/internal/auth"
import { matchesPathPattern, normalizeRoutePath, SIXB_API_ROUTES } from "@sixb/core/internal/http"
import {
  SIXB_ACCESS_TOKEN_MUTATION_SECURITY_REQUIREMENT,
  SIXB_ACCESS_TOKEN_READ_SECURITY_REQUIREMENT,
  SIXB_SHARED_MUTATION_SECURITY_REQUIREMENT,
  SIXB_SHARED_READ_SECURITY_REQUIREMENT,
} from "../openapi/security"
import type { RouteAccess } from "./public-routes"

export interface AccessTokenRoute {
  readonly operationId: string
  readonly method: string
  readonly path: string
  readonly sharedSession: boolean
}

// The routes that accept personal and service-account access tokens: the `accessToken` projection
// of the canonical SIXB_API_ROUTES table in @sixb/core. `isAccessTokenRoute` enforces this list at
// request time and `accessTokenSecurityRequirement` derives each route's OpenAPI security entry
// from it, so the enforced boundary and the documented contract cannot drift apart. The agent
// gateway allow-list is the `agentApi` projection of the same table, which the table's load-time
// invariant keeps a strict subset of this one.
//
// Access tokens should only reach routes that enforce execution-bound authority. Admin, browser,
// webhook, and WebSocket routes stay session-only because access-token use is intentionally absent
// from SIXB_API_ROUTES. A native client's session, though also a bearer token, is a session.
export const ACCESS_TOKEN_ROUTES: readonly AccessTokenRoute[] = SIXB_API_ROUTES.filter(
  (route) => route.accessToken
).map((route) => ({
  operationId: route.operationId,
  method: route.method,
  path: route.path,
  sharedSession: route.sharedSession ?? false,
}))

/**
 * OpenAPI security requirement for a route that accepts access tokens, derived from the canonical
 * table: an access token or a session, plus the CSRF token for a browser session's mutations.
 * Throws when the operation is not a registered access-token route, so a route can never claim
 * access-token use without being added to the boundary.
 */
export function accessTokenSecurityRequirement(operationId: string) {
  const route = ACCESS_TOKEN_ROUTES.find((candidate) => candidate.operationId === operationId)
  if (!route) {
    throw new Error(
      `[SixbServer] '${operationId}' is not a registered access-token route. Add it to ACCESS_TOKEN_ROUTES.`
    )
  }

  const standard = isCsrfExemptMethod(route.method)
    ? SIXB_ACCESS_TOKEN_READ_SECURITY_REQUIREMENT
    : SIXB_ACCESS_TOKEN_MUTATION_SECURITY_REQUIREMENT
  if (!route.sharedSession) return standard
  return [
    ...standard,
    isCsrfExemptMethod(route.method)
      ? SIXB_SHARED_READ_SECURITY_REQUIREMENT
      : SIXB_SHARED_MUTATION_SECURITY_REQUIREMENT,
  ]
}

export function isAccessTokenRoute(request: Request): boolean {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const pathname = normalizeRoutePath(url.pathname)

  return ACCESS_TOKEN_ROUTES.some(
    (route) => route.method === method && matchesPathPattern(pathname, route.path)
  )
}

/** How a request carried its credential: an ambient browser cookie, or an explicit bearer token. */
export type CredentialTransport = "cookie" | "bearer"

export function credentialTransport(caller: AuthenticatedRequestAuthSession): CredentialTransport {
  return caller.credentialSource === "session" && !caller.session.bearer ? "cookie" : "bearer"
}

export function shouldVerifyCsrf(route: RouteAccess, transport: CredentialTransport): boolean {
  // CSRF protects ambient browser cookies. A bearer token (a native client's session or an access
  // token) is an explicit request credential, so it skips CSRF.
  return route.csrfProtected && transport === "cookie"
}
