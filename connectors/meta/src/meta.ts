import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createMetaClient } from "./client"
import {
  assertNonEmpty,
  createMetaResponseObserver,
  createMetaRetryContext,
  createMetaRetryController,
  observeMetaResponses,
} from "./http"
import type { MetaClient } from "./types/client"
import type { MetaRetryContext } from "./types/common"
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
  const retry = createMetaRetryController(options.retry, options.maxRetries)
  const observe = createMetaResponseObserver(options.onResponse)
  const retryContexts = new WeakMap<Response, Promise<MetaRetryContext>>()

  function resolveRetryContext(
    response: Response | null,
    error: unknown,
    attempt: number,
    path: string,
    method: "GET" | "POST"
  ): Promise<MetaRetryContext> {
    if (!response) return createMetaRetryContext(response, error, attempt, { path, method })
    const existing = retryContexts.get(response)
    if (existing) return existing
    const created = createMetaRetryContext(response, error, attempt, { path, method })
    retryContexts.set(response, created)
    return created
  }

  const http = rest({
    baseUrl,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.accessToken}`,
    },
    retry: {
      maxRetries: retry.maxRetries,
      async shouldRetry(context) {
        const method = context.method === "POST" ? "POST" : "GET"
        if (context.response) {
          await observe.observeHttp(context.response, context.path, method)
        }
        return retry.shouldRetry(
          await resolveRetryContext(
            context.response,
            context.error,
            context.attempt,
            context.path,
            method
          )
        )
      },
      async delayMs(context) {
        const method = context.method === "POST" ? "POST" : "GET"
        return retry.delayMs(
          await resolveRetryContext(
            context.response,
            context.error,
            context.attempt,
            context.path,
            method
          )
        )
      },
    },
    timeoutMs: options.timeoutMs,
  })

  return {
    type: "meta",
    async connect(context) {
      const connectedHttp = observeMetaResponses(await http.connect(context), observe)
      return createMetaClient({
        http: connectedHttp,
        retry,
        observe,
        signal: context.signal,
      })
    },
  }
}
