const APP_FRAME_ORIGINS_ENV = "SIXB_APP_FRAME_ORIGINS"

// A CSP host: labels of letters, digits and hyphens. `URL` keeps `*`, `;` and quotes in a host, and
// any of them would rewrite the policy instead of naming a site.
const CSP_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/

/**
 * The sites besides the API that the app's pages may show in an `<iframe>`, from a comma-separated
 * list such as `https://www.youtube-nocookie.com,https://contoso.sharepoint.com`.
 *
 * They join the `frame-src` that keeps artifact frames on the API's origin, and a frame may navigate
 * itself to any site the policy allows: an artifact page could send what it reads to a site listed
 * here. Each entry is therefore one exact origin, never a wildcard, a scheme, or a keyword.
 */
export function readAppFrameOrigins(
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const entries = (env[APP_FRAME_ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

  return [...new Set(entries.map(frameOrigin))]
}

function frameOrigin(entry: string): string {
  if (entry.includes("*")) {
    throw new Error(
      `[SixbCustomApp] ${APP_FRAME_ORIGINS_ENV}: '${entry}' is a wildcard. List each site, such as ` +
        "https://contoso.sharepoint.com: an artifact's frame can navigate to any site this " +
        "variable allows."
    )
  }

  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw notAnOrigin(entry)
  }

  const exact =
    (url.protocol === "https:" || url.protocol === "http:") &&
    CSP_HOST.test(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash

  if (!exact) throw notAnOrigin(entry)

  return url.origin
}

function notAnOrigin(entry: string): Error {
  return new Error(
    `[SixbCustomApp] ${APP_FRAME_ORIGINS_ENV}: '${entry}' is not an origin. Give the scheme, host ` +
      "and optional port of each site, such as https://contoso.sharepoint.com."
  )
}
