export function objectDetailPath(objectId: string): string {
  // encodeObjectId escapes the identity components. Escape the composite once more for transport
  // as a route segment; React Router removes this outer layer before decodeObjectId sees it.
  return `/${encodeURIComponent(objectId)}`
}

export function objectIdFromPathSegment(pathSegment: string): string {
  try {
    return decodeURIComponent(pathSegment)
  } catch {
    return pathSegment
  }
}
