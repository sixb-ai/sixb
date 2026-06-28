export interface AgentApiRoute {
  readonly method: string
  readonly path: string
}

export const AGENT_API_ROUTES: readonly AgentApiRoute[] = [
  { method: "GET", path: "/api/project" },
  { method: "GET", path: "/api/object-types" },
  { method: "GET", path: "/api/object-types/:objectTypeId" },
  { method: "GET", path: "/api/objects" },
  { method: "POST", path: "/api/objects/query" },
  { method: "POST", path: "/api/objects/query/count" },
  { method: "POST", path: "/api/objects/query/exists" },
  { method: "POST", path: "/api/objects/query/facets" },
  { method: "GET", path: "/api/objects/:objectTypeId/:objectId" },
  { method: "POST", path: "/api/telemetry/history" },
  { method: "GET", path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history" },
  { method: "GET", path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest" },
  { method: "GET", path: "/api/actions" },
  { method: "GET", path: "/api/actions/:actionId" },
  { method: "POST", path: "/api/actions/:actionId" },
  { method: "GET", path: "/api/action-runs/:runId" },
]

export function isAllowedAgentApiRequest(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = normalizePath(pathname)
  return AGENT_API_ROUTES.some(
    (route) => route.method === normalizedMethod && matchesPathPattern(normalizedPath, route.path)
  )
}

export function normalizePath(pathname: string): string {
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
