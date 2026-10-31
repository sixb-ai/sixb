import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter, ConnectorContext, OAuthConnectorAdapter } from "@sixb/core"
import { type MetaAccessTokenSource, withAccessToken } from "./auth"
import { createMetaClient } from "./client"
import {
  assertNonEmpty,
  createMetaResponseObserver,
  createMetaRetryContext,
  createMetaRetryController,
  MetaApiError,
  type MetaHttpContext,
  observeMetaResponses,
  readJson,
} from "./http"
import { createMetaAuthentication, discoverMetaPages } from "./oauth"
import type { MetaClient, MetaConnectedPage, MetaPageClient } from "./types/client"
import type { MetaRetryContext } from "./types/common"
import type {
  MetaConnectorOptions,
  MetaOAuthConnectorOptions,
  MetaTransportOptions,
} from "./types/options"
import type { MetaInstagramAccount } from "./types/pages"

const GRAPH_API_HOST = "https://graph.facebook.com"
const DEFAULT_GRAPH_VERSION = "v23.0"

export type MetaConnector = ConnectorAdapter<"meta", MetaClient>
export type MetaOAuthConnector = OAuthConnectorAdapter<"meta", MetaPageClient>

/**
 * Meta connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client over the Graph API for Facebook Pages and
 * Instagram Business/Creator accounts. The default user/system token authorizes
 * Page discovery and Instagram reads; scope Facebook Page reads with a Page access
 * token via `client.facebook(id, { accessToken })`.
 *
 * Pass `appId` and `appSecret` instead of `accessToken` to let users sign in with Facebook:
 * each connection is then one Page, and its client defaults to that Page's token.
 *
 * Register it from a project's `connectors/` directory:
 *
 * ```ts
 * export const metaConnector = defineConnector("meta", meta({
 *   accessToken: process.env.META_GRAPH_ACCESS_TOKEN!,
 * }))
 * ```
 */
export function meta(options: MetaConnectorOptions): MetaConnector
export function meta(options: MetaOAuthConnectorOptions): MetaOAuthConnector
export function meta(
  options: MetaConnectorOptions | MetaOAuthConnectorOptions
): MetaConnector | MetaOAuthConnector
export function meta(
  options: MetaConnectorOptions | MetaOAuthConnectorOptions
): MetaConnector | MetaOAuthConnector {
  if (options.appId !== undefined) return metaOAuth(options)

  const { accessToken } = options
  assertNonEmpty(accessToken, "accessToken")
  const transport = createMetaTransport(options)

  return {
    type: "meta",
    async connect(context) {
      return createMetaClient(await transport.connect(context, accessToken))
    },
  }
}

function metaOAuth(options: MetaOAuthConnectorOptions): MetaOAuthConnector {
  const transport = createMetaTransport(options)
  const authentication = createMetaAuthentication(options, {
    graphBaseUrl: transport.baseUrl,
    graphVersion: transport.version,
  })

  return {
    type: "meta",
    authentication,
    discoverAccounts: (_context, credentials) => discoverMetaPages(credentials),
    async connect(context) {
      const http = await transport.connect(context, context.tokenSource)
      const { pages: _pages, ...client } = createMetaClient(http)
      return {
        ...client,
        account: await readConnectedPage(http, context.account.id, context.account.label),
      }
    },
  }
}

/** Read the Page's name and linked Instagram account when the client connects. */
async function readConnectedPage(
  http: MetaHttpContext,
  pageId: string,
  label: string
): Promise<MetaConnectedPage> {
  type PageNode = {
    readonly name?: string
    readonly instagram_business_account?: MetaInstagramAccount
  }
  const read = async (fields: string) =>
    readJson<PageNode>(await http.http.get(`${encodeURIComponent(pageId)}?fields=${fields}`))

  let page: PageNode
  try {
    page = await read("name,instagram_business_account{id,username}")
  } catch (error) {
    // A grant without instagram_basic is refused the Instagram field, not the Page.
    if (!isPermissionError(error)) throw error
    page = await read("name")
  }
  return {
    pageId,
    name: page.name ?? label,
    ...(page.instagram_business_account
      ? {
          instagram: {
            id: page.instagram_business_account.id,
            ...(page.instagram_business_account.username
              ? { username: page.instagram_business_account.username }
              : {}),
          },
        }
      : {}),
  }
}

function isPermissionError(error: unknown): boolean {
  const code = error instanceof MetaApiError ? error.graphError?.code : undefined
  return code === 10 || (code !== undefined && code >= 200 && code < 300)
}

function createMetaTransport(options: MetaTransportOptions) {
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
    headers: { Accept: "application/json" },
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

  const uploadHttp = rest({
    baseUrl: "https://rupload.facebook.com/",
    timeoutMs: options.timeoutMs,
  })

  return {
    version,
    baseUrl,
    async connect(
      context: ConnectorContext,
      accessToken: MetaAccessTokenSource
    ): Promise<MetaHttpContext> {
      return {
        http: withAccessToken(
          observeMetaResponses(await http.connect(context), observe),
          "Bearer",
          accessToken
        ),
        uploadHttp: withAccessToken(
          observeMetaResponses(await uploadHttp.connect(context), observe),
          "OAuth",
          accessToken
        ),
        retry,
        observe,
        signal: context.signal,
      }
    },
  }
}
