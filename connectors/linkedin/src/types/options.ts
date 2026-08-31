import type { LinkedinExtensibleString } from "./common"

export type LinkedinAccountType = "ad-account" | "organization"

/**
 * OAuth scopes currently used by LinkedIn's Advertising and Community Management products.
 * The open-string fallback keeps monthly LinkedIn additions usable without a connector release.
 */
export type LinkedinOAuthScope = LinkedinExtensibleString<
  | "r_ads"
  | "rw_ads"
  | "r_ads_reporting"
  | "rw_organization_admin"
  | "r_organization_social"
  | "w_organization_social"
  | "r_organization_social_feed"
  | "w_organization_social_feed"
  | "r_member_social_feed"
  | "w_member_social"
  | "w_member_social_feed"
  | "r_member_profileAnalytics"
  | "r_member_postAnalytics"
>

export type LinkedinRequestMethod = "GET" | "POST" | "PUT" | "DELETE"

export interface LinkedinRetryContext {
  readonly attempt: number
  /** Logical method. A tunneled GET remains `GET`. */
  readonly method: LinkedinRequestMethod
  readonly response: Response | null
  readonly error: unknown
}

export interface LinkedinRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: LinkedinRetryContext): boolean
  delayMs?(context: LinkedinRetryContext): number
}

export interface LinkedinConnectorOptions {
  /** Client ID of the LinkedIn developer application for this connector definition. */
  readonly clientId: string
  /** Client secret of the LinkedIn developer application. Never exposed to connected clients. */
  readonly clientSecret: string
  /** OAuth scopes requested from LinkedIn. Keep this list to the minimum required by the syncs. */
  readonly scopes: readonly LinkedinOAuthScope[]
  /** Account surface exposed to Sixb's account-selection flow. */
  readonly accountType: LinkedinAccountType
  /** LinkedIn Marketing API version in YYYYMM form. Defaults to 202608. */
  readonly version?: string
  /** Defaults to https://api.linkedin.com/rest/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Optional delay between requests. */
  readonly minDelayMs?: number
  /** By default, only transient logical GET failures are retried. */
  readonly retry?: LinkedinRetryPolicy
  /**
   * GET query-string length at which query tunneling is used. Defaults to 3,500 bytes, below
   * LinkedIn's 4 KB query-string limit. Set to 0 to tunnel every GET with a query string.
   */
  readonly queryTunnelingThreshold?: number
}
