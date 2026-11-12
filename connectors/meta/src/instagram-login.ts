import {
  type ConnectorAccountCandidate,
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
  nextCursor,
  nonEmptyString,
} from "./oauth"
import type { MetaInstagramOAuthConnectorOptions } from "./types/options"

type UnifiedLoginOptions = Extract<
  MetaInstagramOAuthConnectorOptions,
  { readonly configId: string }
>

const FACEBOOK_DIALOG_HOST = "https://www.facebook.com"
const ACCOUNT_LIMIT = 100
// 100 pages of 100 accounts is far beyond any real portfolio and stops a cursor that never ends.
const MAX_ACCOUNT_REQUESTS = 100

/** Grant context stored encrypted with the token: who granted it and the accounts shared. */
type InstagramGrantAccount = { readonly username?: string }

/**
 * Instagram API with Unified Login, built on Facebook Login for Business: the client logs in with
 * Instagram or Facebook, picks a business portfolio and the Instagram accounts to share. The code
 * is exchanged with the Meta app ID and secret for a Business Integration System User token that
 * covers every shared account; no Page and no long-lived exchange are involved. The token never
 * expires unless the configuration says otherwise; it stops working when the client removes the
 * app from their portfolio, and reconnecting is the only way back.
 */
export function createMetaInstagramAuthentication(
  options: UnifiedLoginOptions,
  endpoints: MetaOAuthEndpoints
): ConnectorOAuth2Authentication {
  assertNonEmpty(options.appId, "appId")
  assertNonEmpty(options.appSecret, "appSecret")
  assertNonEmpty(options.configId, "configId")

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
      url.searchParams.set("config_id", options.configId)
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
      const accessToken = accessTokenOf(exchanged, "code exchange")
      const systemUser = await readSystemUser(context, options, endpoints, accessToken)
      const accounts = await readAssignedAccounts(context, options, endpoints, accessToken)
      if (Object.keys(accounts).length === 0) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbMeta] The login shared no Instagram account. Connect again and select an Instagram professional account."
        )
      }
      const expiresIn = Number(exchanged.expires_in)
      return {
        accessToken,
        tokenType: "Bearer",
        // A configuration with an expiry: Sixb asks to reconnect before the token stops working.
        ...(Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        authorizationContext: {
          ...(nonEmptyString(systemUser.id) ? { systemUserId: systemUser.id } : {}),
          ...(nonEmptyString(systemUser.client_business_id)
            ? { clientBusinessId: systemUser.client_business_id }
            : {}),
          instagramAccounts: accounts,
        },
      }
    },

    refresh() {
      throw new ConnectorOAuthError(
        "terminal",
        "[SixbMeta] Unified Login tokens are not refreshed by the connector; connect again."
      )
    },
    // No revoke: Meta documents none for these tokens. The client removes the app in Business
    // settings > Integrations > Connected apps.
  }
}

/** The Instagram accounts the client shared, as framework-owned account candidates. */
export function discoverMetaInstagramAccounts(
  credentials: ConnectorOAuthCredentials
): readonly ConnectorAccountCandidate[] {
  return Object.entries(grantAccounts(credentials)).map(([id, account]) => ({
    id,
    label: account.username ? `@${account.username}` : id,
    description: "Instagram professional account",
  }))
}

/**
 * Who the token belongs to, kept as context only: a configuration that does not allow reading
 * `client_business_id` still connects, with the system user alone or nothing.
 */
async function readSystemUser(
  context: ConnectorContext,
  options: UnifiedLoginOptions,
  endpoints: MetaOAuthEndpoints,
  accessToken: string
): Promise<Record<string, unknown>> {
  for (const fields of ["id,client_business_id", "id"]) {
    try {
      return await graphRequest(context, options, endpoints, "user read", {
        method: "GET",
        path: "me",
        query: { fields },
        accessToken,
      })
    } catch (error) {
      if (!(error instanceof ConnectorOAuthError) || error.kind !== "terminal") throw error
    }
  }
  return {}
}

async function readAssignedAccounts(
  context: ConnectorContext,
  options: UnifiedLoginOptions,
  endpoints: MetaOAuthEndpoints,
  accessToken: string
): Promise<Record<string, InstagramGrantAccount>> {
  const accounts: Record<string, InstagramGrantAccount> = {}
  let after: string | undefined
  for (let request = 0; request < MAX_ACCOUNT_REQUESTS; request++) {
    const body = await graphRequest(context, options, endpoints, "Instagram accounts read", {
      method: "GET",
      path: "me/assigned_instagram_accounts",
      query: { fields: "id,username", limit: String(ACCOUNT_LIMIT), ...(after ? { after } : {}) },
      accessToken,
    })
    for (const raw of Array.isArray(body.data) ? body.data : []) {
      if (!isRecord(raw) || !nonEmptyString(raw.id)) continue
      accounts[raw.id] = nonEmptyString(raw.username) ? { username: raw.username } : {}
    }
    after = nextCursor(body)
    if (!after) return accounts
  }
  throw new ConnectorOAuthError(
    "terminal",
    "[SixbMeta] Meta returned more Instagram accounts than the connector reads."
  )
}

function grantAccounts(
  credentials: ConnectorOAuthCredentials
): Readonly<Record<string, InstagramGrantAccount>> {
  const accounts = credentials.authorizationContext?.instagramAccounts
  if (!isRecord(accounts)) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbMeta] The Instagram grant has no accounts; reauthorization is required."
    )
  }
  const result: Record<string, InstagramGrantAccount> = {}
  for (const [id, account] of Object.entries(accounts)) {
    if (!isRecord(account)) continue
    result[id] = nonEmptyString(account.username) ? { username: account.username } : {}
  }
  return result
}
