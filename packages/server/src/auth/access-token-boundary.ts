import { isCsrfExemptMethod } from "@sixb/core/internal/auth"
import { matchesPathPattern, normalizeRoutePath, SIXB_API_ROUTES } from "@sixb/core/internal/http"
import {
  SIXB_BEARER_SECURITY_REQUIREMENT,
  SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
} from "../openapi/security"
import type { RouteAccess } from "./public-routes"

export type AuthCredentialSource = "session" | "accessToken"

export interface AccessTokenRoute {
  readonly operationId: string
  readonly method: string
  readonly path: string
}

// The routes that accept bearer access tokens: the `accessToken` projection of the canonical
// SIXB_API_ROUTES table in @sixb/core. `isAccessTokenRoute` enforces this list at request time and
// `bearerSecurityRequirement` derives each route's OpenAPI security entry from it, so the enforced
// boundary and the documented contract cannot drift apart. The agent gateway allow-list is the
// `agentApi` projection of the same table, which the table's load-time invariant keeps a strict
// subset of this one.
//
// Bearer tokens should only reach routes that already enforce scoped authz. Raw storage, admin,
// browser, webhook, and websocket routes stay session-only until each has an intentional scoped
// API surface — i.e. they are simply absent from SIXB_API_ROUTES.
export const ACCESS_TOKEN_ROUTES: readonly AccessTokenRoute[] = SIXB_API_ROUTES.filter(
  (route) => route.accessToken
).map((route) => ({ operationId: route.operationId, method: route.method, path: route.path }))

/**
 * OpenAPI security requirement for a bearer-capable route, derived from the
 * canonical table. Reads (CSRF-exempt methods) accept a bearer token only;
 * mutations accept either a CSRF token (cookie sessions) or a bearer token.
 * Throws when the operation is not a registered bearer route, so a route can
 * never claim bearer access without being added to the boundary.
 */
export function bearerSecurityRequirement(operationId: string) {
  const route = ACCESS_TOKEN_ROUTES.find((candidate) => candidate.operationId === operationId)
  if (!route) {
    throw new Error(
      `[SixbServer] '${operationId}' is not a registered bearer route. Add it to ACCESS_TOKEN_ROUTES.`
    )
  }

  return isCsrfExemptMethod(route.method)
    ? SIXB_BEARER_SECURITY_REQUIREMENT
    : SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT
}

export function isAccessTokenRoute(request: Request): boolean {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const pathname = normalizeRoutePath(url.pathname)

  return ACCESS_TOKEN_ROUTES.some(
    (route) => route.method === method && matchesPathPattern(pathname, route.path)
  )
}

export function shouldVerifyCsrfForAuthSource(
  route: RouteAccess,
  source: AuthCredentialSource
): boolean {
  // CSRF protects ambient browser cookies. Bearer tokens are explicit request
  // credentials, so they skip CSRF while still requiring authz checks.
  return route.csrfProtected && source === "session"
}
