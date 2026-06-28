export function normalizeApiBaseUrl(value: string): string {
  const withoutTrailingSlash = value.trim().replace(/\/+$/, "")
  if (withoutTrailingSlash.endsWith("/api")) {
    return withoutTrailingSlash.slice(0, -"/api".length)
  }
  return withoutTrailingSlash
}
