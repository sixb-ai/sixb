/**
 * Shared HTTP route-pattern matching. Used by both the agent API gateway allow-list (@sixb/core)
 * and the server's access-token boundary (@sixb/server) so the two never drift.
 */

/** Split a path into its non-empty segments (drops leading/trailing/empty parts). */
export function pathSegmentsFor(pathname: string): string[] {
  return pathname.split("/").filter(Boolean)
}

/**
 * Match a concrete pathname against a route pattern. A `:param` pattern segment matches any single
 * non-empty segment; every other segment must match exactly. Segment counts must be equal.
 */
export function matchesPathPattern(pathname: string, pattern: string): boolean {
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

/** Strip a single trailing slash so `/api/foo` and `/api/foo/` compare equal (leaves "/" alone). */
export function normalizeRoutePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }
  return pathname
}
