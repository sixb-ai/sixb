export function normalizeSixbApiBaseUrl(value: string): string {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
  let url: URL

  try {
    url = new URL(value, absolute ? undefined : "http://sixb.local")
  } catch {
    throw new Error(`[SixbClient] Invalid API base URL '${value}'.`)
  }

  const pathname = stripTrailingApiPath(url.pathname)
  if (!absolute) {
    return pathname
  }

  return `${url.origin}${pathname === "/" ? "" : pathname}`
}

function stripTrailingApiPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "")
  if (!trimmed || trimmed === "/api") {
    return ""
  }

  if (trimmed.endsWith("/api")) {
    return trimmed.slice(0, -4) || ""
  }

  return trimmed
}
