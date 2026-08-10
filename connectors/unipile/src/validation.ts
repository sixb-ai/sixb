export function pathId(value: string, label: string): string {
  assertNonEmpty(value, label)
  return encodeURIComponent(value)
}

export function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbUnipile] ${label} must not be empty.`)
  }
}

export function assertLimit(limit: number | undefined, max = 250): void {
  if (limit === undefined) {
    return
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`[SixbUnipile] limit must be an integer between 1 and ${max}.`)
  }
}

export function assertHttpUrl(value: string, label: string): void {
  assertNonEmpty(value, label)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbUnipile] ${label} must be a valid HTTP(S) URL.`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[SixbUnipile] ${label} must be a valid HTTP(S) URL.`)
  }
}

export function assertLinkedinPeopleSearchUrl(value: string): void {
  assertHttpUrl(value, "LinkedIn search URL")
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
    throw new Error("[SixbUnipile] LinkedIn search URL must use linkedin.com.")
  }

  const path = url.pathname.toLowerCase().replace(/\/+$/, "")
  const isPeopleSearch =
    path === "/search/results/people" ||
    path === "/sales/search/people" ||
    path.startsWith("/sales/lists/people/") ||
    (path.startsWith("/talent/") && path.includes("search"))

  if (!isPeopleSearch) {
    throw new Error("[SixbUnipile] LinkedIn search URL must represent a people search.")
  }
}

export function assertTimestamp(value: string, label: string): void {
  assertNonEmpty(value, label)
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`[SixbUnipile] ${label} must be a valid ISO 8601 timestamp.`)
  }
}

export function assertInvitationMessage(message: string | undefined): void {
  if (message !== undefined && Array.from(message).length > 300) {
    throw new Error("[SixbUnipile] invitation message must be at most 300 characters.")
  }
}

export function assertStringArray(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`[SixbUnipile] ${label} must contain at least one value.`)
  }
  for (const value of values) {
    assertNonEmpty(value, `${label} entry`)
  }
}
