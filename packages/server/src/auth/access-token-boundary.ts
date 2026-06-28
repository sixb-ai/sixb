import { isCsrfExemptMethod } from "@sixb/core"
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

// The single source of truth for which routes accept bearer access tokens.
// `isAccessTokenRoute` enforces this list at request time and
// `bearerSecurityRequirement` derives each route's OpenAPI security entry from
// it, so the enforced boundary and the documented contract cannot drift apart.
//
// Bearer tokens should only reach routes that already enforce scoped authz. Raw
// storage, admin, browser, webhook, and websocket routes stay session-only
// until each has an intentional scoped API surface.
export const ACCESS_TOKEN_ROUTES: readonly AccessTokenRoute[] = [
  { operationId: "getProjectInfo", method: "GET", path: "/api/project" },
  // Token and service-account management is bearer-capable so the CLI can
  // authenticate with a personal access token. The runtime still confines every
  // operation to the caller's own groups, and service-account tokens are
  // rejected (only user principals may manage credentials).
  {
    operationId: "getAuthAccessManagementOptions",
    method: "GET",
    path: "/api/auth/access-management-options",
  },
  { operationId: "listAuthAccessTokens", method: "GET", path: "/api/auth/access-tokens" },
  { operationId: "createAuthPersonalAccessToken", method: "POST", path: "/api/auth/access-tokens" },
  {
    operationId: "revokeAuthAccessToken",
    method: "POST",
    path: "/api/auth/access-tokens/:tokenId/revoke",
  },
  { operationId: "listAuthServiceAccounts", method: "GET", path: "/api/auth/service-accounts" },
  { operationId: "createAuthServiceAccount", method: "POST", path: "/api/auth/service-accounts" },
  {
    operationId: "disableAuthServiceAccount",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/disable",
  },
  {
    operationId: "listAuthServiceAccountAccessTokens",
    method: "GET",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens",
  },
  {
    operationId: "createAuthServiceAccountAccessToken",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens",
  },
  {
    operationId: "revokeAuthServiceAccountAccessToken",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens/:tokenId/revoke",
  },
  { operationId: "listObjectTypes", method: "GET", path: "/api/object-types" },
  { operationId: "getObjectType", method: "GET", path: "/api/object-types/:objectTypeId" },
  { operationId: "listObjects", method: "GET", path: "/api/objects" },
  { operationId: "queryObjects", method: "POST", path: "/api/objects/query" },
  { operationId: "countObjects", method: "POST", path: "/api/objects/query/count" },
  { operationId: "existsObjects", method: "POST", path: "/api/objects/query/exists" },
  { operationId: "facetObjects", method: "POST", path: "/api/objects/query/facets" },
  { operationId: "getObject", method: "GET", path: "/api/objects/:objectTypeId/:objectId" },
  { operationId: "getBulkTelemetryHistory", method: "POST", path: "/api/telemetry/history" },
  {
    operationId: "getTelemetryHistory",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
  },
  {
    operationId: "getLatestTelemetry",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
  },
  { operationId: "listActions", method: "GET", path: "/api/actions" },
  { operationId: "getAction", method: "GET", path: "/api/actions/:actionId" },
  { operationId: "requestAction", method: "POST", path: "/api/actions/:actionId" },
  { operationId: "getActionRun", method: "GET", path: "/api/action-runs/:runId" },
  { operationId: "listWorkflows", method: "GET", path: "/api/workflows" },
  { operationId: "getWorkflow", method: "GET", path: "/api/workflows/:workflowId" },
  { operationId: "requestWorkflowRun", method: "POST", path: "/api/workflows/:workflowId/runs" },
  { operationId: "listEvents", method: "GET", path: "/api/events" },
]

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
  const pathname = normalizePath(url.pathname)

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

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }

  return pathname
}

function matchesPathPattern(pathname: string, pattern: string): boolean {
  const pathSegments = pathSegmentsFor(pathname)
  const patternSegments = pathSegmentsFor(pattern)

  if (pathSegments.length !== patternSegments.length) {
    return false
  }

  return patternSegments.every((patternSegment, index) => {
    if (patternSegment.startsWith(":")) {
      return pathSegments[index] !== ""
    }

    return patternSegment === pathSegments[index]
  })
}

function pathSegmentsFor(pathname: string): string[] {
  return pathname.split("/").filter(Boolean)
}
