import { rest } from "@sixb/connector-rest"
import { defineConnector } from "@sixb/core"
import { PanasonicApiService } from "../lib/panasonic/api"
import { PanasonicAuth } from "../lib/panasonic/auth"
import { buildPanasonicHeaders } from "../lib/panasonic/headers"
import { API_CONSTANTS } from "../lib/panasonic/types"
import { resolvePanasonicAppVersion } from "../lib/panasonic/version"

function getCredentials(): { email: string; password: string } {
  const email = process.env.PANASONIC_EMAIL
  const password = process.env.PANASONIC_PASSWORD

  if (!email || !password) {
    throw new Error(
      "[Panasonic] Missing PANASONIC_EMAIL or PANASONIC_PASSWORD environment variables."
    )
  }

  return { email, password }
}

/**
 * Panasonic Comfort Cloud REST connector.
 *
 * Auto-discovered by `createSixb()` from the `connectors/` directory.
 * On first use (`sixb.connectors.connect(panasonicConnector)`), the adapter:
 * 1. Authenticates via OAuth2 PKCE using credentials from environment variables
 * 2. Creates a `rest()` client configured with Panasonic-specific headers,
 *    rate-limiting, retry, and automatic token refresh on 401
 *
 * Tokens live in memory for the lifetime of the Sixb runtime.
 * `PanasonicAuth.getAccessToken()` transparently refreshes tokens nearing expiry.
 * If a 401 still occurs (e.g. server-side revocation), a full re-authentication is performed.
 *
 * Required environment variables:
 * - `PANASONIC_EMAIL` — Panasonic ID email
 * - `PANASONIC_PASSWORD` — Panasonic ID password
 *
 * Optional environment variables:
 * - `PANASONIC_APP_VERSION` — overrides automatic App Store version detection
 */
export const panasonicConnector = defineConnector("panasonic", {
  type: "panasonic",

  async connect(context) {
    const { email, password } = getCredentials()
    const appVersion = await resolvePanasonicAppVersion({
      override: process.env.PANASONIC_APP_VERSION,
      signal: context.signal,
    })
    const auth = new PanasonicAuth(appVersion)
    await auth.authenticate(email, password)

    const adapter = rest({
      baseUrl: API_CONSTANTS.API_BASE,
      headers: () => buildPanasonicHeaders(auth, appVersion),
      minDelayMs: 1000,
      timeoutMs: 30_000,
      onUnauthorized: async () => {
        try {
          await auth.refreshTokensWithRetry()
        } catch {
          // Refresh token expired or revoked — full re-authentication
          await auth.authenticate(email, password)
        }
      },
      retry: { maxRetries: 3 },
    })

    const client = await adapter.connect(context)
    return new PanasonicApiService(client)
  },
})
