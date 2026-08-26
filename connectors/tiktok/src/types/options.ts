import type { TiktokResponseMetadata, TiktokRetryOptions } from "./common"

interface TiktokConnectorOptionsBase {
  /** TikTok Business API base URL. Override only for compatible proxies and tests. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly retry?: TiktokRetryOptions
  readonly onResponse?: (metadata: TiktokResponseMetadata) => Promise<void> | void
}

export interface TiktokOrganicConnectorOptions extends TiktokConnectorOptionsBase {
  readonly accountType: "organic-account"
  /** Client ID from the TikTok for Business app. */
  readonly clientId: string
  readonly clientSecret: string
  /** Full TikTok account-holder authorization URL copied from the app portal. */
  readonly authorizationUrl: string
  /** Add `disable_auto_auth=1` to force the account chooser. */
  readonly disableAutoAuth?: boolean
}

export interface TiktokAdsConnectorOptions extends TiktokConnectorOptionsBase {
  readonly accountType: "ad-account"
  readonly appId: string
  readonly secret: string
  /** Optional Ads authorization scope string. Omit to request the app's current permissions. */
  readonly scope?: string
}

export type TiktokConnectorOptions = TiktokOrganicConnectorOptions | TiktokAdsConnectorOptions
