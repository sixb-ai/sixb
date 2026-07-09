import { type RestConnector, rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createTokenSource } from "./auth"
import { createGoogleClient, type GoogleClient } from "./client"
import { createGoogleHttp, type GoogleHttpClients, type GoogleSurface } from "./http"
import type { GoogleConnectorOptions } from "./types"

/**
 * Base URL per Google API surface. Adding a surface is a one-line entry here
 * (plus its typed resources and one wiring line in `client.ts`); the shared
 * auth + HTTP core is never touched.
 */
const BASE_URLS = {
  drive: "https://www.googleapis.com/drive/v3/",
  calendar: "https://www.googleapis.com/calendar/v3/",
} as const satisfies Record<GoogleSurface, string>

export type GoogleConnector = ConnectorAdapter<"google", GoogleClient>

export function google(options: GoogleConnectorOptions): GoogleConnector {
  const token = createTokenSource(options.auth)

  const common = {
    headers: async () => ({ Authorization: `Bearer ${await token.get()}` }),
    // The REST adapter fires this on a 401 only, so a stale token is dropped and
    // the request is retried once with a fresh one. 403 (scope) does not churn it.
    onUnauthorized: () => token.invalidate(),
    retry: options.retry ?? { maxRetries: 2 },
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
  }

  const surfaces = Object.fromEntries(
    Object.entries(BASE_URLS).map(([surface, baseUrl]) => [surface, rest({ ...common, baseUrl })])
  ) as Record<GoogleSurface, RestConnector>

  return {
    type: "google",
    async connect(context) {
      const entries = await Promise.all(
        Object.entries(surfaces).map(
          async ([surface, adapter]) => [surface, await adapter.connect(context)] as const
        )
      )
      const clients = Object.fromEntries(entries) as GoogleHttpClients
      return createGoogleClient(createGoogleHttp(clients))
    },
  }
}
