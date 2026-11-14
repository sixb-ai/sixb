import {
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import { assertNonEmpty } from "./http"
import {
  accessTokenOf,
  graphRequest,
  isRecord,
  type MetaOAuthEndpoints,
  nonEmptyString,
} from "./oauth"
import type { MetaInstagramOAuthConnectorOptions } from "./types/options"

type InstagramLoginOptions = Extract<
  MetaInstagramOAuthConnectorOptions,
  { readonly login: "instagram" }
>

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize"
const CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token"
const INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com/"
const DEFAULT_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const

/**
 * Instagram API with Instagram Login (Business Login for Instagram): the client signs in on
 * instagram.com with the professional account's own credentials, without a Facebook Page or a
 * business portfolio. Each sign-in grants one account.
 *
 * The code gives a one-hour token, exchanged at once for a 60-day one. Instagram issues no refresh
 * token: a long-lived token refreshes itself, once it is a day old and while it is still valid. The
 * connector keeps it as its own refresh token, and reports an expiry at half its life, so Sixb
 * refreshes it at the first use after 30 days and leaves 30 days of syncs to do so.
 *
 * Secrets travel in a form body or the Authorization header, except in the long-lived exchange,
 * which Instagram serves only as a GET with the secret in its query (server to server, over TLS).
 *
 * `reauthenticate` asks for the account's credentials on every sign-in, even when the browser is
 * signed in to Instagram: an agency connects each client's account without switching accounts on
 * instagram.com first.
 */
export function createMetaInstagramLoginAuthentication(
  options: InstagramLoginOptions,
  endpoints: Pick<MetaOAuthEndpoints, "graphVersion">
): ConnectorOAuth2Authentication {
  assertNonEmpty(options.appId, "appId")
  assertNonEmpty(options.appSecret, "appSecret")
  const scopes = options.scopes ?? DEFAULT_SCOPES
  if (scopes.length === 0) throw new Error("[SixbMeta] scopes must not be empty.")
  const instagram: MetaOAuthEndpoints = {
    graphBaseUrl: INSTAGRAM_GRAPH_HOST,
    graphVersion: endpoints.graphVersion,
    service: "Instagram",
  }

  return {
    type: "oauth2",
    // The code is exchanged server-side with the app secret.
    pkce: "disabled",

    authorizationUrl(context, input) {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set("client_id", options.appId)
      url.searchParams.set("redirect_uri", context.redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("scope", scopes.join(","))
      url.searchParams.set("state", input.state)
      if (options.reauthenticate) url.searchParams.set("force_reauth", "true")
      return url
    },

    async exchangeCode(context, input) {
      const exchanged = firstGrant(
        await graphRequest(context, options, instagram, "code exchange", {
          method: "POST",
          path: CODE_EXCHANGE_URL,
          form: {
            client_id: options.appId,
            client_secret: options.appSecret,
            grant_type: "authorization_code",
            redirect_uri: context.redirectUri,
            // Instagram appends `#_` to the redirect; it is not part of the code.
            code: input.code.replace(/#_$/, ""),
          },
        })
      )
      const shortLived = accessTokenOf(exchanged, "code exchange")
      // Instagram accepts this exchange only as a GET with its parameters in the query.
      const longLived = await graphRequest(context, options, instagram, "token exchange", {
        method: "GET",
        path: "access_token",
        query: {
          grant_type: "ig_exchange_token",
          client_secret: options.appSecret,
          access_token: shortLived,
        },
      })
      const credentials = longLivedCredentials(longLived, "token exchange")
      const account = await readAccount(context, options, instagram, credentials.accessToken)
      const grantAccount: Record<string, string> = account.username
        ? { username: account.username }
        : {}
      const granted = grantedScopes(exchanged.permissions)
      return {
        ...credentials,
        ...(granted.length > 0 ? { scopes: granted } : {}),
        authorizationContext: {
          instagramAccounts: { [account.id]: grantAccount },
        },
      }
    },

    async refresh(context, current) {
      const token = current.refreshToken ?? current.accessToken
      const refreshed = await graphRequest(context, options, instagram, "token refresh", {
        method: "GET",
        path: "refresh_access_token",
        query: { grant_type: "ig_refresh_token" },
        accessToken: token,
      })
      return longLivedCredentials(refreshed, "token refresh")
    },
    // No revoke: Instagram documents none. The client removes the app in Instagram's settings
    // (Apps and websites).
  }
}

/** The code exchange answers either the grant itself or `{ data: [grant] }`. */
function firstGrant(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.data)) return body
  const [grant] = body.data
  if (!isRecord(grant)) {
    throw new ConnectorOAuthError(
      "ambiguous",
      "[SixbMeta] Instagram returned no grant in the code exchange response."
    )
  }
  return grant
}

/** Instagram answers the granted permissions as a list; its docs show a comma-separated string. */
function grantedScopes(permissions: unknown): readonly string[] {
  const values = Array.isArray(permissions)
    ? permissions
    : typeof permissions === "string"
      ? permissions.split(",")
      : []
  return values.filter(nonEmptyString).map((scope) => scope.trim())
}

function longLivedCredentials(
  body: Record<string, unknown>,
  operation: "token exchange" | "token refresh"
): Pick<ConnectorOAuthCredentials, "accessToken" | "refreshToken" | "tokenType" | "expiresAt"> {
  const accessToken = accessTokenOf(body, operation)
  const expiresIn = Number(body.expires_in)
  return {
    accessToken,
    // The long-lived token is what Instagram refreshes.
    refreshToken: accessToken,
    tokenType: "Bearer",
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + (expiresIn * 1000) / 2) }
      : {}),
  }
}

/** The professional account that signed in: `user_id` is its ID in every other call. */
async function readAccount(
  context: ConnectorContext,
  options: InstagramLoginOptions,
  endpoints: MetaOAuthEndpoints,
  accessToken: string
): Promise<{ readonly id: string; readonly username?: string }> {
  const me = await graphRequest(context, options, endpoints, "user read", {
    method: "GET",
    path: `${endpoints.graphVersion}/me`,
    query: { fields: "user_id,username" },
    accessToken,
  })
  const id = nonEmptyString(me.user_id) ? me.user_id : me.id
  if (!nonEmptyString(id)) {
    throw new ConnectorOAuthError(
      "ambiguous",
      "[SixbMeta] Instagram returned no account for the signed-in user."
    )
  }
  return { id, ...(nonEmptyString(me.username) ? { username: me.username } : {}) }
}
