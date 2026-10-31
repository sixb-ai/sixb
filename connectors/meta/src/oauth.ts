import {
  type ConnectorAccountCandidate,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import { assertNonEmpty, isThrottlingError, parseMetaBody, parseMetaGraphError } from "./http"
import type { MetaOAuthConnectorOptions } from "./types/options"

const FACEBOOK_DIALOG_HOST = "https://www.facebook.com"
const PAGE_FIELDS = "id,name,access_token"
// Instagram fields need instagram_basic; a Pages-only grant is refused when it asks for them.
const PAGE_INSTAGRAM_FIELDS = `${PAGE_FIELDS},instagram_business_account{id,username}`
const PAGE_LIMIT = 100
// 100 pages of 100 is far beyond any real account and stops a cursor that never ends.
const MAX_PAGE_REQUESTS = 100

/**
 * Grant context stored encrypted with the user token. Page tokens derived from a long-lived user
 * token do not expire, so they keep publishing after the ~60-day user token is gone.
 */
type MetaGrantPage = {
  readonly accessToken: string
  readonly name: string
  readonly instagramUsername?: string
}

type OAuthOperation =
  | "code exchange"
  | "token exchange"
  | "user read"
  | "permissions read"
  | "Pages read"
  | "revoke"

export interface MetaOAuthEndpoints {
  readonly graphBaseUrl: string
  readonly graphVersion: string
}

export function createMetaAuthentication(
  options: MetaOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints
): ConnectorOAuth2Authentication {
  assertNonEmpty(options.appId, "appId")
  assertNonEmpty(options.appSecret, "appSecret")
  const login = loginParameter(options)

  return {
    type: "oauth2",
    // The code is exchanged server-side with the app secret.
    pkce: "disabled",

    authorizationUrl(context, input) {
      const url = new URL(`${FACEBOOK_DIALOG_HOST}/${endpoints.graphVersion}/dialog/oauth`)
      url.searchParams.set("client_id", options.appId)
      url.searchParams.set("redirect_uri", context.redirectUri)
      url.searchParams.set("state", input.state)
      url.searchParams.set("response_type", "code")
      url.searchParams.set(login.name, login.value)
      return url
    },

    async exchangeCode(context, input) {
      const exchanged = await graphRequest(context, options, endpoints, "code exchange", {
        method: "POST",
        path: "oauth/access_token",
        form: {
          client_id: options.appId,
          client_secret: options.appSecret,
          redirect_uri: context.redirectUri,
          code: input.code,
        },
      })
      const longLived = await graphRequest(context, options, endpoints, "token exchange", {
        method: "POST",
        path: "oauth/access_token",
        form: {
          grant_type: "fb_exchange_token",
          client_id: options.appId,
          client_secret: options.appSecret,
          fb_exchange_token: accessTokenOf(exchanged, "code exchange"),
        },
      })
      const accessToken = accessTokenOf(longLived, "token exchange")
      const user = await graphRequest(context, options, endpoints, "user read", {
        method: "GET",
        path: "me",
        query: { fields: "id" },
        accessToken,
      })
      if (!nonEmptyString(user.id)) {
        throw new ConnectorOAuthError(
          "ambiguous",
          "[SixbMeta] Facebook returned no user id for the signed-in account."
        )
      }

      const scopes = await readGrantedScopes(context, options, endpoints, accessToken)
      const pages = await readGrantedPages(context, options, endpoints, {
        accessToken,
        instagram: scopes === undefined || scopes.includes("instagram_basic"),
      })
      if (Object.keys(pages).length === 0) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbMeta] The Facebook account granted no Pages. Connect again and select at least one Page."
        )
      }

      // No `expiresAt`: the user token expires after ~60 days, but the Page tokens that do the
      // work do not. Sixb would otherwise send a healthy connection to reauthorization.
      return {
        accessToken,
        tokenType: "Bearer",
        ...(scopes === undefined ? {} : { scopes }),
        authorizationContext: { userId: user.id, pages },
      }
    },

    accountAccessToken(credentials, account) {
      return { accessToken: grantPage(credentials, account.id).accessToken, tokenType: "Bearer" }
    },

    refresh() {
      throw new ConnectorOAuthError(
        "terminal",
        "[SixbMeta] Facebook Login tokens do not refresh; reauthorization is required."
      )
    },

    async revoke(context, credentials) {
      // The user token is usually expired by the time a grant is revoked, so revoke as the app.
      const userId = credentials.authorizationContext?.userId
      if (!nonEmptyString(userId)) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbMeta] The Facebook grant has no user id to revoke."
        )
      }
      try {
        await graphRequest(context, options, endpoints, "revoke", {
          method: "DELETE",
          path: `${encodeURIComponent(userId)}/permissions`,
          accessToken: `${options.appId}|${options.appSecret}`,
        })
      } catch (error) {
        // Graph answers 100 for a user who already removed the app: nothing is left to revoke.
        if (error instanceof MetaOAuthRequestError && error.graphCode === 100) return
        throw error
      }
    },
  }
}

/** The Pages the user granted, as framework-owned account candidates. */
export function discoverMetaPages(
  credentials: ConnectorOAuthCredentials
): readonly ConnectorAccountCandidate[] {
  return Object.entries(grantPages(credentials)).map(([id, page]) => ({
    id,
    label: page.name,
    description: page.instagramUsername
      ? `Facebook Page · Instagram @${page.instagramUsername}`
      : "Facebook Page",
  }))
}

function loginParameter(options: MetaOAuthConnectorOptions): {
  readonly name: "config_id" | "scope"
  readonly value: string
} {
  const { configId, scopes } = options
  if ((configId === undefined) === (scopes === undefined)) {
    throw new Error("[SixbMeta] Pass exactly one of configId or scopes.")
  }
  if (configId !== undefined) {
    assertNonEmpty(configId, "configId")
    return { name: "config_id", value: configId }
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("[SixbMeta] scopes must contain at least one permission.")
  }
  for (const scope of scopes) {
    assertNonEmpty(scope, "OAuth scope")
    if (/[\s,]/.test(scope)) {
      throw new Error("[SixbMeta] each OAuth scope must be a single permission name.")
    }
  }
  return { name: "scope", value: [...new Set(scopes)].join(",") }
}

async function readGrantedPages(
  context: ConnectorContext,
  options: MetaOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints,
  grant: { readonly accessToken: string; readonly instagram: boolean }
): Promise<Record<string, MetaGrantPage>> {
  const pages: Record<string, MetaGrantPage> = {}
  let after: string | undefined

  for (let request = 0; request < MAX_PAGE_REQUESTS; request++) {
    const body = await graphRequest(context, options, endpoints, "Pages read", {
      method: "GET",
      path: "me/accounts",
      query: {
        fields: grant.instagram ? PAGE_INSTAGRAM_FIELDS : PAGE_FIELDS,
        limit: String(PAGE_LIMIT),
        ...(after ? { after } : {}),
      },
      accessToken: grant.accessToken,
    })

    for (const raw of Array.isArray(body.data) ? body.data : []) {
      const page = toGrantPage(raw)
      if (page) pages[page.id] = page.grant
    }

    after = nextCursor(body)
    if (!after) return pages
  }
  throw new ConnectorOAuthError(
    "terminal",
    "[SixbMeta] Facebook returned more Page results than the connector reads."
  )
}

async function readGrantedScopes(
  context: ConnectorContext,
  options: MetaOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints,
  accessToken: string
): Promise<readonly string[] | undefined> {
  const body = await graphRequest(context, options, endpoints, "permissions read", {
    method: "GET",
    path: "me/permissions",
    accessToken,
  })
  if (!Array.isArray(body.data)) return undefined
  const granted = body.data.flatMap((entry) =>
    isRecord(entry) && entry.status === "granted" && typeof entry.permission === "string"
      ? [entry.permission]
      : []
  )
  return granted.length > 0 ? granted : undefined
}

function toGrantPage(
  raw: unknown
): { readonly id: string; readonly grant: MetaGrantPage } | undefined {
  // A Page without a token (no task granted on it) cannot be used by a connection.
  if (!isRecord(raw) || !nonEmptyString(raw.id) || !nonEmptyString(raw.access_token)) {
    return undefined
  }
  const instagram = isRecord(raw.instagram_business_account)
    ? raw.instagram_business_account
    : undefined
  return {
    id: raw.id,
    grant: {
      accessToken: raw.access_token,
      name: nonEmptyString(raw.name) ? raw.name : raw.id,
      ...(nonEmptyString(instagram?.username) ? { instagramUsername: instagram.username } : {}),
    },
  }
}

function grantPages(
  credentials: ConnectorOAuthCredentials
): Readonly<Record<string, MetaGrantPage>> {
  const pages = credentials.authorizationContext?.pages
  if (!isRecord(pages)) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbMeta] The Facebook grant has no Pages; reauthorization is required."
    )
  }
  const result: Record<string, MetaGrantPage> = {}
  for (const [id, page] of Object.entries(pages)) {
    if (isRecord(page) && nonEmptyString(page.accessToken) && nonEmptyString(page.name)) {
      result[id] = {
        accessToken: page.accessToken,
        name: page.name,
        ...(nonEmptyString(page.instagramUsername)
          ? { instagramUsername: page.instagramUsername }
          : {}),
      }
    }
  }
  return result
}

function grantPage(credentials: ConnectorOAuthCredentials, pageId: string): MetaGrantPage {
  const page = grantPages(credentials)[pageId]
  if (!page) {
    throw new Error(`[SixbMeta] The Facebook grant does not include Page ${pageId}.`)
  }
  return page
}

class MetaOAuthRequestError extends ConnectorOAuthError {
  constructor(
    kind: ConstructorParameters<typeof ConnectorOAuthError>[0],
    message: string,
    readonly graphCode?: number,
    options?: ErrorOptions
  ) {
    super(kind, message, options)
  }
}

interface GraphRequest {
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly form?: Readonly<Record<string, string>>
  readonly accessToken?: string
}

async function graphRequest(
  context: ConnectorContext,
  options: MetaOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints,
  operation: OAuthOperation,
  request: GraphRequest
): Promise<Record<string, unknown>> {
  const url = new URL(request.path, endpoints.graphBaseUrl)
  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(name, value)
  }
  const signal = options.timeoutMs
    ? AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)])
    : context.signal

  let response: Response
  let rawBody: string
  try {
    // Secrets travel in the form body or the Authorization header, never in the URL.
    response = await fetch(url, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.accessToken ? { Authorization: `Bearer ${request.accessToken}` } : {}),
      },
      ...(request.form ? { body: new URLSearchParams(request.form) } : {}),
      redirect: "error",
      signal,
    })
    rawBody = await response.text()
  } catch (error) {
    throw new MetaOAuthRequestError(
      "ambiguous",
      `[SixbMeta] Facebook ${operation} ended without a readable response.`,
      undefined,
      { cause: error }
    )
  }

  const body = parseMetaBody(rawBody)
  if (!response.ok) {
    const graphError = parseMetaGraphError(body)
    const retryable =
      response.status === 429 || response.status >= 500 || isThrottlingError(graphError)
    const detail = graphError?.message ? `: ${graphError.message}` : ""
    throw new MetaOAuthRequestError(
      retryable ? "retryable" : "terminal",
      `[SixbMeta] Facebook rejected the ${operation} (${response.status})${detail}.`,
      graphError?.code
    )
  }
  if (!isRecord(body)) {
    throw new MetaOAuthRequestError(
      "ambiguous",
      `[SixbMeta] Facebook returned an invalid ${operation} response.`
    )
  }
  return body
}

function accessTokenOf(body: Record<string, unknown>, operation: OAuthOperation): string {
  if (!nonEmptyString(body.access_token)) {
    throw new ConnectorOAuthError(
      "ambiguous",
      `[SixbMeta] Facebook returned no access token in the ${operation} response.`
    )
  }
  return body.access_token
}

function nextCursor(body: Record<string, unknown>): string | undefined {
  const paging = isRecord(body.paging) ? body.paging : undefined
  if (!nonEmptyString(paging?.next)) return undefined
  const cursors = isRecord(paging.cursors) ? paging.cursors : undefined
  return nonEmptyString(cursors?.after) ? cursors.after : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
