import type {
  ConnectorAccountCandidate,
  ConnectorContext,
  ConnectorOAuthCredentials,
  OAuthConnectorAdapter,
} from "@sixb/core"
import { createAdsClient } from "./ads/client"
import { assertNonEmpty, createTiktokHttp, fixedTokenSource } from "./http"
import { createTiktokAuthentication } from "./oauth"
import { createOrganicClient } from "./organic/client"
import type { TiktokAdsClient, TiktokOrganicClient } from "./types/client"
import type {
  TiktokAdsConnectorOptions,
  TiktokConnectorOptions,
  TiktokOrganicConnectorOptions,
} from "./types/options"
import type { TiktokOrganicProfile } from "./types/organic"

export type TiktokOrganicConnector = OAuthConnectorAdapter<"tiktok", TiktokOrganicClient>
export type TiktokAdsConnector = OAuthConnectorAdapter<"tiktok", TiktokAdsClient>
export type TiktokConnector = TiktokOrganicConnector | TiktokAdsConnector

interface OrganicTokenInfo {
  readonly app_id?: string
  readonly scope?: string
  readonly creator_id: string
}

interface AdvertiserListData {
  readonly list?: readonly {
    readonly advertiser_id: string
    readonly advertiser_name?: string
  }[]
}

/** Create a managed TikTok connector for one of TikTok's two distinct OAuth grants. */
export function tiktok(options: TiktokOrganicConnectorOptions): TiktokOrganicConnector
export function tiktok(options: TiktokAdsConnectorOptions): TiktokAdsConnector
export function tiktok(options: TiktokConnectorOptions): TiktokConnector {
  validateOptions(options)
  const authentication = createTiktokAuthentication(options)

  if (options.accountType === "organic-account") {
    return {
      type: "tiktok",
      authentication,
      discoverAccounts: (context, credentials) =>
        discoverOrganicAccount(context, options, credentials),
      async connect(context) {
        const http = await createTiktokHttp(context, options, context.tokenSource)
        return createOrganicClient(http, {
          type: "organic-account",
          ...context.account,
        })
      },
    }
  }

  return {
    type: "tiktok",
    authentication,
    discoverAccounts: (context, credentials) => discoverAdvertisers(context, options, credentials),
    async connect(context) {
      const http = await createTiktokHttp(context, options, context.tokenSource)
      return createAdsClient(http, {
        type: "ad-account",
        ...context.account,
      })
    },
  }
}

async function discoverOrganicAccount(
  context: ConnectorContext,
  options: TiktokOrganicConnectorOptions,
  credentials: ConnectorOAuthCredentials
): Promise<readonly ConnectorAccountCandidate[]> {
  const http = await createTiktokHttp(context, options, fixedTokenSource(credentials.accessToken))
  const tokenInfo = await http.post<OrganicTokenInfo>(
    "tt_user/token_info/get/",
    { app_id: options.clientId, access_token: credentials.accessToken },
    { authenticated: false }
  )
  assertNonEmpty(tokenInfo.data.creator_id, "creator_id")

  const profile = await http.get<TiktokOrganicProfile>("business/get/", {
    business_id: tokenInfo.data.creator_id,
    fields: ["display_name", "username", "profile_image", "bio_description"],
  })
  const label = profile.data.display_name || profile.data.username || tokenInfo.data.creator_id
  return [
    {
      id: tokenInfo.data.creator_id,
      label,
      description: profile.data.username
        ? `@${profile.data.username}`
        : profile.data.bio_description,
      avatarUrl: profile.data.profile_image,
    },
  ]
}

async function discoverAdvertisers(
  context: ConnectorContext,
  options: TiktokAdsConnectorOptions,
  credentials: ConnectorOAuthCredentials
): Promise<readonly ConnectorAccountCandidate[]> {
  const http = await createTiktokHttp(context, options, fixedTokenSource(credentials.accessToken))
  const result = await http.get<AdvertiserListData>("oauth2/advertiser/get/", {
    app_id: options.appId,
    secret: options.secret,
  })
  return (result.data.list ?? []).map((advertiser) => ({
    id: advertiser.advertiser_id,
    label: advertiser.advertiser_name || advertiser.advertiser_id,
  }))
}

function validateOptions(options: TiktokConnectorOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("[SixbTikTok] timeoutMs must be a positive number.")
  }

  if (options.accountType === "organic-account") {
    assertNonEmpty(options.clientId, "clientId")
    assertNonEmpty(options.clientSecret, "clientSecret")
    assertNonEmpty(options.authorizationUrl, "authorizationUrl")
    return
  }

  assertNonEmpty(options.appId, "appId")
  assertNonEmpty(options.secret, "secret")
  if (options.scope !== undefined) assertNonEmpty(options.scope, "scope")
}
