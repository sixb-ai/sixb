import { type RestClient, rest } from "@sixb/connector-rest"
import type { ConnectorAdapter, ConnectorContext } from "@sixb/core"
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

/**
 * Media upload lives on a separate host path (`/upload/<api>/<version>`),
 * only for surfaces with upload endpoints. Same auth and HTTP core.
 */
const UPLOAD_BASE_URLS: Partial<Record<GoogleSurface, string>> = {
  drive: "https://www.googleapis.com/upload/drive/v3/",
}

export type GoogleConnector = ConnectorAdapter<"google", GoogleClient>

export function google(options: GoogleConnectorOptions): GoogleConnector {
  const token = createTokenSource(options.auth)

  const common = {
    headers: () =>
      token.getRequestHeaders?.() ??
      token.get().then((accessToken) => new Headers({ Authorization: `Bearer ${accessToken}` })),
    // The REST adapter fires this on a 401 only, so a stale token is dropped and
    // the request is retried once with a fresh one. 403 (scope) does not churn it.
    onUnauthorized: () => token.invalidate(),
    retry: options.retry ?? { maxRetries: 2 },
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
  }

  const connectAll = async (
    urls: Record<string, string>,
    context: ConnectorContext
  ): Promise<Record<string, RestClient>> =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(urls).map(
          async ([surface, baseUrl]) =>
            [surface, await rest({ ...common, baseUrl }).connect(context)] as const
        )
      )
    )

  return {
    type: "google",
    async connect(context) {
      const [api, upload] = await Promise.all([
        connectAll(BASE_URLS, context),
        connectAll(UPLOAD_BASE_URLS, context),
      ])
      const clients: GoogleHttpClients = {
        api: api as GoogleHttpClients["api"],
        upload,
      }
      return createGoogleClient(createGoogleHttp(clients))
    },
  }
}
