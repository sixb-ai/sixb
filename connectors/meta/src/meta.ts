import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createMetaClient } from "./client"
import { assertNonEmpty } from "./http"
import type { MetaClient } from "./types/client"
import type { MetaConnectorOptions } from "./types/options"

const GRAPH_API_HOST = "https://graph.facebook.com"
const DEFAULT_GRAPH_VERSION = "v23.0"

export type MetaConnector = ConnectorAdapter<"meta", MetaClient>

/**
 * Meta connector built on `@sixb/connector-rest`.
 *
 * Returns a typed, read-only client over the Graph API for Facebook Pages and
 * Instagram Business/Creator accounts. The default user/system token authorizes
 * Page discovery and Instagram reads; scope Facebook Page reads with a Page access
 * token via `client.facebook(id, { accessToken })`.
 *
 * Register it from a project's `connectors/` directory:
 *
 * ```ts
 * export const metaConnector = defineConnector("meta", meta({
 *   accessToken: process.env.META_GRAPH_ACCESS_TOKEN!,
 * }))
 * ```
 */
export function meta(options: MetaConnectorOptions): MetaConnector {
  assertNonEmpty(options.accessToken, "accessToken")

  const version = options.graphVersion ?? DEFAULT_GRAPH_VERSION
  const baseUrl = options.baseUrl ?? `${GRAPH_API_HOST}/${version}/`

  const http = rest({
    baseUrl,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.accessToken}`,
    },
    retry: { maxRetries: options.maxRetries ?? 2 },
    timeoutMs: options.timeoutMs,
  })

  return {
    type: "meta",
    async connect(context) {
      return createMetaClient(await http.connect(context))
    },
  }
}
