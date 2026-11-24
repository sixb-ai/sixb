import {
  type ConnectorAccountCandidate,
  type ConnectorContext,
  type ConnectorOAuth2Authentication,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import {
  createMetaAuthentication,
  exchangeFacebookLoginCode,
  graphRequest,
  isGraphPermissionError,
  isRecord,
  type MetaOAuthEndpoints,
  nextCursor,
  nonEmptyString,
  readGrantedScopes,
} from "./oauth"
import type { MetaAdAccountOAuthConnectorOptions } from "./types/options"

const AD_ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name"
// The portfolio that owns each account. A token refused it still reads the accounts themselves.
const AD_ACCOUNT_BUSINESS_FIELD = "business{name}"
const AD_ACCOUNT_LIMIT = 100
// 100 pages of 100 is far beyond any real person's accounts and stops a cursor that never ends.
const MAX_AD_ACCOUNT_REQUESTS = 100

/** Grant context stored encrypted with the user token, keyed by the bare ad account id. */
type AdAccountGrant = {
  readonly name: string
  readonly businessName?: string
  readonly currency?: string
  readonly timeZone?: string
}

/**
 * Facebook Login for ad accounts: the same dialog, exchanges and revocation as Pages, but the
 * long-lived user token does the work. Meta derives no non-expiring token per ad account, so the
 * grant carries the user token's expiry (~60 days) and Sixb sends it to reauthorization in time
 * instead of failing syncs. Meta issues no refresh token: reconnecting is the only way to extend it.
 */
export function createMetaAdAccountAuthentication(
  options: MetaAdAccountOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints
): ConnectorOAuth2Authentication {
  if (options.login !== undefined) {
    throw new Error(
      '[SixbMeta] login is not supported with accounts: "ads"; sign in with Facebook.'
    )
  }
  // Dialog, refresh (none) and revocation as the app are those of every Facebook Login grant.
  const facebookLogin = createMetaAuthentication(options, endpoints)

  return {
    ...facebookLogin,

    async exchangeCode(context, input) {
      const { accessToken, userId, expiresIn } = await exchangeFacebookLoginCode(
        context,
        options,
        endpoints,
        input.code
      )
      const scopes = await readGrantedScopes(context, options, endpoints, accessToken)
      const adAccounts = await readGrantedAdAccounts(context, options, endpoints, accessToken)
      if (Object.keys(adAccounts).length === 0) {
        throw new ConnectorOAuthError(
          "terminal",
          "[SixbMeta] The Facebook account granted no ad accounts. Connect again and tick at least one ad account."
        )
      }
      return {
        accessToken,
        tokenType: "Bearer",
        ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
        ...(scopes === undefined ? {} : { scopes }),
        authorizationContext: { userId, adAccounts },
      }
    },

    accountAccessToken(credentials, account) {
      // One user token reaches every granted ad account; refuse one the sign-in did not grant.
      if (!grantAdAccounts(credentials)[account.id]) {
        throw new Error(`[SixbMeta] The Facebook grant does not include ad account ${account.id}.`)
      }
      return { accessToken: credentials.accessToken, tokenType: "Bearer" }
    },
  }
}

/**
 * The ad accounts the person granted, as framework-owned account candidates. The description
 * names the account id, which tells apart a person's accounts that often share their name.
 */
export function discoverMetaAdAccounts(
  credentials: ConnectorOAuthCredentials
): readonly ConnectorAccountCandidate[] {
  return Object.entries(grantAdAccounts(credentials)).map(([id, account]) => ({
    id,
    label: account.name,
    description: [`Ad account ${id}`, account.businessName].filter(Boolean).join(" · "),
  }))
}

async function readGrantedAdAccounts(
  context: ConnectorContext,
  options: MetaAdAccountOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints,
  accessToken: string
): Promise<Record<string, AdAccountGrant>> {
  const read = (fields: string) =>
    readAdAccountPages(context, options, endpoints, { accessToken, fields })
  try {
    return await read(`${AD_ACCOUNT_FIELDS},${AD_ACCOUNT_BUSINESS_FIELD}`)
  } catch (error) {
    // A grant refused the business field keeps its ad accounts, without their portfolio's name.
    if (!isGraphPermissionError(error)) throw error
    return read(AD_ACCOUNT_FIELDS)
  }
}

async function readAdAccountPages(
  context: ConnectorContext,
  options: MetaAdAccountOAuthConnectorOptions,
  endpoints: MetaOAuthEndpoints,
  request: { readonly accessToken: string; readonly fields: string }
): Promise<Record<string, AdAccountGrant>> {
  const accounts: Record<string, AdAccountGrant> = {}
  let after: string | undefined

  for (let page = 0; page < MAX_AD_ACCOUNT_REQUESTS; page++) {
    const body = await graphRequest(context, options, endpoints, "ad accounts read", {
      method: "GET",
      path: "me/adaccounts",
      query: {
        fields: request.fields,
        limit: String(AD_ACCOUNT_LIMIT),
        ...(after ? { after } : {}),
      },
      accessToken: request.accessToken,
    })

    for (const raw of Array.isArray(body.data) ? body.data : []) {
      const account = toAdAccountGrant(raw)
      if (account) accounts[account.id] = account.grant
    }

    after = nextCursor(body)
    if (!after) return accounts
  }
  throw new ConnectorOAuthError(
    "terminal",
    "[SixbMeta] Facebook returned more ad accounts than the connector reads."
  )
}

function toAdAccountGrant(
  raw: unknown
): { readonly id: string; readonly grant: AdAccountGrant } | undefined {
  if (!isRecord(raw)) return undefined
  const id = adAccountIdOf(raw)
  if (!id) return undefined
  const business = isRecord(raw.business) ? raw.business : undefined
  return {
    id,
    grant: {
      name: nonEmptyString(raw.name) ? raw.name : id,
      ...(nonEmptyString(business?.name) ? { businessName: business.name } : {}),
      ...(nonEmptyString(raw.currency) ? { currency: raw.currency } : {}),
      ...(nonEmptyString(raw.timezone_name) ? { timeZone: raw.timezone_name } : {}),
    },
  }
}

/** The bare numeric id, as `client.ads.account()` accepts it: `account_id`, or `id` without `act_`. */
function adAccountIdOf(raw: Record<string, unknown>): string | undefined {
  const candidate = nonEmptyString(raw.account_id)
    ? raw.account_id
    : nonEmptyString(raw.id)
      ? raw.id.replace(/^act_/, "")
      : undefined
  return candidate !== undefined && /^\d+$/.test(candidate) ? candidate : undefined
}

function grantAdAccounts(
  credentials: ConnectorOAuthCredentials
): Readonly<Record<string, AdAccountGrant>> {
  const accounts = credentials.authorizationContext?.adAccounts
  if (!isRecord(accounts)) {
    throw new ConnectorOAuthError(
      "terminal",
      "[SixbMeta] The Facebook grant has no ad accounts; reauthorization is required."
    )
  }
  const result: Record<string, AdAccountGrant> = {}
  for (const [id, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !nonEmptyString(account.name)) continue
    result[id] = {
      name: account.name,
      ...(nonEmptyString(account.businessName) ? { businessName: account.businessName } : {}),
      ...(nonEmptyString(account.currency) ? { currency: account.currency } : {}),
      ...(nonEmptyString(account.timeZone) ? { timeZone: account.timeZone } : {}),
    }
  }
  return result
}
