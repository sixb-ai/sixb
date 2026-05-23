import type { SixbApiBrowserPolicy, SixbBrowserOrigin } from "../src"

export function createTestBrowserPolicy(
  options: {
    readonly apiOrigin?: string
    readonly atlasOrigin?: string
    readonly appOrigin?: string
    readonly includeApp?: boolean
  } = {}
): SixbApiBrowserPolicy {
  const atlasOrigin = options.atlasOrigin ?? "http://atlas.localhost"
  const appOrigin = options.appOrigin ?? "http://app.localhost"
  const includeApp = options.includeApp ?? true
  const allowedOrigins: SixbBrowserOrigin[] = [
    { origin: atlasOrigin, audience: "atlas", kind: "atlas" },
  ]

  if (includeApp) {
    allowedOrigins.push({ origin: appOrigin, audience: "app", kind: "app" })
  }

  return {
    publicOrigin: options.apiOrigin ?? "http://api.localhost",
    allowedOrigins,
  }
}
