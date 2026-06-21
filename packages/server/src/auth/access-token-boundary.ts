import type { RouteAccess } from "./public-routes"

export type AuthCredentialSource = "session" | "accessToken"

interface AccessTokenRoutePattern {
  readonly method: string
  readonly path: string
}

// Bearer tokens should only reach routes that already enforce scoped authz.
// Raw storage, admin, browser, webhook, and websocket routes stay session-only
// until each has an intentional scoped API surface.
const ACCESS_TOKEN_ROUTE_PATTERNS: readonly AccessTokenRoutePattern[] = [
  { method: "GET", path: "/api/project" },
  { method: "GET", path: "/api/object-types" },
  { method: "GET", path: "/api/object-types/:objectTypeId" },
  { method: "GET", path: "/api/objects" },
  { method: "POST", path: "/api/objects/query" },
  { method: "POST", path: "/api/objects/query/count" },
  { method: "POST", path: "/api/objects/query/exists" },
  { method: "POST", path: "/api/objects/query/facets" },
  { method: "GET", path: "/api/objects/:objectTypeId/:objectId" },
  { method: "GET", path: "/api/actions" },
  { method: "GET", path: "/api/actions/:actionId" },
  { method: "POST", path: "/api/actions/:actionId" },
  { method: "GET", path: "/api/workflows" },
  { method: "GET", path: "/api/workflows/:workflowId" },
  { method: "POST", path: "/api/workflows/:workflowId/runs" },
  { method: "GET", path: "/api/events" },
]

export function isAccessTokenRoute(request: Request): boolean {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const pathname = normalizePath(url.pathname)

  return ACCESS_TOKEN_ROUTE_PATTERNS.some(
    (pattern) => pattern.method === method && matchesPathPattern(pathname, pattern.path)
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
