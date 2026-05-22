export function normalizePublicOrigin(value: string, label = "publicOrigin"): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[ParioServer] ${label} must be a valid http or https URL.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[ParioServer] ${label} must use http or https.`)
  }

  if (url.username || url.password) {
    throw new Error(`[ParioServer] ${label} must not include credentials.`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[ParioServer] ${label} must be an origin without path, query, or hash.`)
  }

  return url.origin
}
