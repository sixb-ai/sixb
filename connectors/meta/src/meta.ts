import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter, ConnectorContext, OAuthConnectorAdapter } from "@sixb/core"
import { createMetaAdAccountAuthentication, discoverMetaAdAccounts } from "./ad-account-login"
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
import { createMetaInstagramLoginAuthentication } from "./instagram-business-login"
import { createMetaInstagramAuthentication, discoverMetaInstagramAccounts } from "./instagram-login"
import { createMetaAuthentication, discoverMetaPages, nonEmptyString } from "./oauth"
import type { MetaAdAccount } from "./types/ads"
import type {
  MetaAdAccountClient,
  MetaClient,
  MetaConnectedAdAccount,
  MetaConnectedInstagramAccount,
  MetaConnectedPage,
  MetaInstagramAccountClient,
  MetaPageClient,
} from "./types/client"
import type { MetaRetryContext } from "./types/common"
import type {
  MetaAdAccountOAuthConnectorOptions,
  MetaConnectorOptions,
  MetaInstagramOAuthConnectorOptions,
  MetaOAuthConnectorOptions,
  MetaTransportOptions,
} from "./types/options"
import type { MetaInstagramAccount } from "./types/pages"

const GRAPH_API_HOST = "https://graph.facebook.com"
const INSTAGRAM_GRAPH_API_HOST = "https://graph.instagram.com"
const DEFAULT_GRAPH_VERSION = "v23.0"

export type MetaConnector = ConnectorAdapter<"meta", MetaClient>
export type MetaOAuthConnector = OAuthConnectorAdapter<"meta", MetaPageClient>
export type MetaInstagramOAuthConnector = OAuthConnectorAdapter<"meta", MetaInstagramAccountClient>
export type MetaAdAccountOAuthConnector = OAuthConnectorAdapter<"meta", MetaAdAccountClient>

/**
 * Meta connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client over the Graph API for Facebook Pages and
 * Instagram Business/Creator accounts. The default user/system token authorizes
 * Page discovery and Instagram reads; scope Facebook Page reads with a Page access
 * token via `client.facebook(id, { accessToken })`.
 *
 * Pass `appId` and `appSecret` instead of `accessToken` to let users sign in with Facebook:
 * each connection is then one Page, and its client defaults to that Page's token. Add
 * `accounts: "instagram"` with a Unified Login `configId`, or with `login: "instagram"` and the
 * Instagram app's ID and secret for Instagram Login, to connect Instagram professional accounts
 * without a Page: each connection is then one Instagram account. Add `accounts: "ads"` to connect
 * the ad accounts the person can advertise on: each connection is then one ad account.
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
export function meta(options: MetaInstagramOAuthConnectorOptions): MetaInstagramOAuthConnector
export function meta(options: MetaAdAccountOAuthConnectorOptions): MetaAdAccountOAuthConnector
export function meta(
  options:
    | MetaConnectorOptions
    | MetaOAuthConnectorOptions
    | MetaInstagramOAuthConnectorOptions
    | MetaAdAccountOAuthConnectorOptions
): MetaConnector | MetaOAuthConnector | MetaInstagramOAuthConnector | MetaAdAccountOAuthConnector
export function meta(
  options:
    | MetaConnectorOptions
    | MetaOAuthConnectorOptions
    | MetaInstagramOAuthConnectorOptions
    | MetaAdAccountOAuthConnectorOptions
): MetaConnector | MetaOAuthConnector | MetaInstagramOAuthConnector | MetaAdAccountOAuthConnector {
  if (options.appId !== undefined && options.accounts === "ads") return metaAdAccountOAuth(options)
  if (options.appId !== undefined && options.accounts === "instagram")
    return options.login === "instagram"
      ? metaInstagramLoginOAuth(options)
      : metaInstagramOAuth(options)
  if (options.appId !== undefined) return metaOAuth(options as MetaOAuthConnectorOptions)

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
      const { ads: _ads, pages: _pages, ...client } = createMetaClient(http)
      return {
        ...client,
        account: await readConnectedPage(http, context.account.id, context.account.label),
      }
    },
  }
}

function metaAdAccountOAuth(
  options: MetaAdAccountOAuthConnectorOptions
): MetaAdAccountOAuthConnector {
  const transport = createMetaTransport(options)
  const authentication = createMetaAdAccountAuthentication(options, {
    graphBaseUrl: transport.baseUrl,
    graphVersion: transport.version,
  })

  return {
    type: "meta",
    authentication,
    discoverAccounts: (_context, credentials) => discoverMetaAdAccounts(credentials),
    async connect(context) {
      const http = await transport.connect(context, context.tokenSource)
      const { ads, batch } = createMetaClient(http)
      return {
        ads: { account: ads.account },
        batch,
        account: await readConnectedAdAccount(ads, context.account.id, context.account.label),
      }
    },
  }
}

const CONNECTED_AD_ACCOUNT_FIELDS = ["name", "currency", "timezone_name"]

/** Read the ad account's name, business, currency and time zone when the client connects. */
async function readConnectedAdAccount(
  ads: MetaClient["ads"],
  adAccountId: string,
  label: string
): Promise<MetaConnectedAdAccount> {
  const read = (fields: readonly string[]) => ads.account(adAccountId).get({ fields })

  let account: MetaAdAccount
  try {
    account = await read([...CONNECTED_AD_ACCOUNT_FIELDS, "business{name}"])
  } catch (error) {
    // A token refused the business field still reads the account, without its portfolio's name.
    if (!isPermissionError(error)) throw error
    account = await read(CONNECTED_AD_ACCOUNT_FIELDS)
  }
  const businessName = account.business?.name
  return {
    adAccountId,
    name: nonEmptyString(account.name) ? account.name : label,
    ...(nonEmptyString(businessName) ? { businessName } : {}),
    ...(nonEmptyString(account.currency) ? { currency: account.currency } : {}),
    ...(nonEmptyString(account.timezone_name) ? { timeZone: account.timezone_name } : {}),
  }
}

function metaInstagramOAuth(
  options: Extract<MetaInstagramOAuthConnectorOptions, { readonly configId: string }>
): MetaInstagramOAuthConnector {
  const transport = createMetaTransport(options)
  return instagramAccountConnector(
    transport,
    createMetaInstagramAuthentication(options, {
      graphBaseUrl: transport.baseUrl,
      graphVersion: transport.version,
    })
  )
}

/** Instagram Login: the same Instagram client, on `graph.instagram.com` with the account's token. */
function metaInstagramLoginOAuth(
  options: Extract<MetaInstagramOAuthConnectorOptions, { readonly login: "instagram" }>
): MetaInstagramOAuthConnector {
  const transport = createMetaTransport(options, INSTAGRAM_GRAPH_API_HOST)
  return instagramAccountConnector(
    transport,
    createMetaInstagramLoginAuthentication(options, { graphVersion: transport.version })
  )
}

function instagramAccountConnector(
  transport: ReturnType<typeof createMetaTransport>,
  authentication: MetaInstagramOAuthConnector["authentication"]
): MetaInstagramOAuthConnector {
  return {
    type: "meta",
    authentication,
    discoverAccounts: (_context, credentials) => discoverMetaInstagramAccounts(credentials),
    async connect(context) {
      const http = await transport.connect(context, context.tokenSource)
      const {
        ads: _ads,
        pages: _pages,
        facebook: _facebook,
        facebookVideo: _video,
        ...client
      } = createMetaClient(http)
      return {
        ...client,
        account: await readConnectedInstagramAccount(
          http,
          context.account.id,
          context.account.label
        ),
      }
    },
  }
}

/** Read the Instagram account's username and name when the client connects. */
async function readConnectedInstagramAccount(
  http: MetaHttpContext,
  instagramAccountId: string,
  label: string
): Promise<MetaConnectedInstagramAccount> {
  const account = await readJson<{ readonly username?: string; readonly name?: string }>(
    await http.http.get(`${encodeURIComponent(instagramAccountId)}?fields=username,name`)
  )
  const username = account.username ?? (label.startsWith("@") ? label.slice(1) : undefined)
  return {
    instagramAccountId,
    ...(username ? { username } : {}),
    ...(account.name ? { name: account.name } : {}),
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

function createMetaTransport(options: MetaTransportOptions, host = GRAPH_API_HOST) {
  const version = options.graphVersion ?? DEFAULT_GRAPH_VERSION
  const baseUrl = options.baseUrl ?? `${host}/${version}/`
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
        // graph.instagram.com has no batch endpoint.
        batchRequests: host === INSTAGRAM_GRAPH_API_HOST ? "separate" : "graph",
      }
    },
  }
}
