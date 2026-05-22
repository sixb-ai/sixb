import { rest } from "@pario/connector-rest"
import { defineConnector } from "@pario/core"
import { PanasonicAuth } from "../lib/panasonic/auth"
import { buildPanasonicHeaders } from "../lib/panasonic/headers"
import { API_CONSTANTS } from "../lib/panasonic/types"

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
 * Auto-discovered by `createPario()` from the `connectors/` directory.
 * On first use (`pario.connector(panasonicConnector)`), the adapter:
 * 1. Authenticates via OAuth2 PKCE using credentials from environment variables
 * 2. Creates a `rest()` client configured with Panasonic-specific headers,
 *    rate-limiting, retry, and automatic token refresh on 401
 *
 * Tokens live in memory for the lifetime of the Pario runtime.
 * `PanasonicAuth.getAccessToken()` transparently refreshes tokens nearing expiry.
 * If a 401 still occurs (e.g. server-side revocation), a full re-authentication is performed.
 *
 * Required environment variables:
 * - `PANASONIC_EMAIL` — Panasonic ID email
 * - `PANASONIC_PASSWORD` — Panasonic ID password
 */
export const panasonicConnector = defineConnector("panasonic", {
  type: "rest",

  async connect(context) {
    const { email, password } = getCredentials()
    const auth = new PanasonicAuth()
    await auth.authenticate(email, password)

    const adapter = rest({
      baseUrl: API_CONSTANTS.API_BASE,
      headers: () => buildPanasonicHeaders(auth),
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

    return adapter.connect(context)
  },
})
