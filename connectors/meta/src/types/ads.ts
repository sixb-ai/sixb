import type { MetaPage, MetaPaginationOptions } from "./common"

/**
 * Read-only Marketing API surface: ad accounts, their campaigns, ad sets, ads and creatives, and
 * Ads Insights. Requests use the connector's token, which needs `ads_read` (or `ads_management`)
 * on the ad accounts it reads.
 */
export interface MetaAdsApi {
  /** `GET /me/adaccounts` — ad accounts the token's user or system user can use. */
  readonly adAccounts: MetaListEdge<MetaAdAccount, MetaAdsListOptions>

  /** Scope for a business portfolio and the ad accounts it owns or was shared. */
  business(businessId: string): MetaBusinessAdsApi

  /** Scope for one ad account. Accepts `act_<id>` or the bare numeric id. */
  account(adAccountId: string): MetaAdAccountApi
}

/** A cursor-paginated edge: `list` reads one page, `listAll` follows every cursor. */
export interface MetaListEdge<TItem, TOptions extends MetaPaginationOptions> {
  list(options?: TOptions): Promise<MetaPage<TItem>>
  listAll(options?: Omit<TOptions, "after">): AsyncIterable<TItem>
}

export interface MetaBusinessAdsApi {
  /** `GET /{business-id}/owned_ad_accounts` — ad accounts the business portfolio owns. */
  readonly ownedAdAccounts: MetaListEdge<MetaAdAccount, MetaAdsListOptions>
  /** `GET /{business-id}/client_ad_accounts` — ad accounts other businesses shared as partner. */
  readonly clientAdAccounts: MetaListEdge<MetaAdAccount, MetaAdsListOptions>
  /** `GET /{business-id}/pending_client_ad_accounts` — partner shares not yet accepted. */
  readonly pendingClientAdAccounts: MetaListEdge<MetaPendingAdAccount, MetaAdsListOptions>
}

export interface MetaAdAccountApi {
  /** `GET /act_{id}`. */
  get(options?: { readonly fields?: readonly string[] }): Promise<MetaAdAccount>
  /** `GET /act_{id}/campaigns`. */
  readonly campaigns: MetaListEdge<MetaAdCampaign, MetaAdObjectListOptions>
  /** `GET /act_{id}/adsets`. */
  readonly adSets: MetaListEdge<MetaAdSet, MetaAdObjectListOptions>
  /** `GET /act_{id}/ads`. */
  readonly ads: MetaListEdge<MetaAd, MetaAdObjectListOptions>
  /** `GET /act_{id}/adcreatives`. */
  readonly adCreatives: MetaListEdge<MetaAdCreative, MetaAdCreativeListOptions>
  /** `GET /act_{id}/insights` — synchronous Ads Insights, paginated. */
  readonly insights: MetaListEdge<MetaAdsInsight, MetaAdsInsightsQuery>
}

/** Field selection and page size for an ads list. Unknown fields are passed through. */
export interface MetaAdsListOptions extends MetaPaginationOptions {
  readonly fields?: readonly string[]
}

export interface MetaAdObjectListOptions extends MetaAdsListOptions {
  /**
   * Sent as `effective_status`. Meta omits archived objects unless they are named here; pass
   * every status a report may still reference. These edges refuse `DELETED` (subcode 1815001).
   */
  readonly effectiveStatus?: readonly Exclude<MetaAdEffectiveStatus, "DELETED">[]
  /** Keeps objects updated after this instant (`updated_time` filter). */
  readonly updatedSince?: Date
}

export interface MetaAdCreativeListOptions extends MetaAdsListOptions {
  /** Sent as `thumbnail_width` and `thumbnail_height` when `thumbnail_url` is requested. */
  readonly thumbnailSize?: { readonly width: number; readonly height: number }
}

export type MetaAdsInsightsLevel = "account" | "campaign" | "adset" | "ad"

export interface MetaAdsInsightsQuery extends MetaAdsListOptions {
  readonly level?: MetaAdsInsightsLevel
  /** Inclusive dates in the ad account's time zone, `YYYY-MM-DD`. */
  readonly timeRange: { readonly since: string; readonly until: string }
  /** `1` for one row per day, `"monthly"`, or `"all_days"` (Meta's default). */
  readonly timeIncrement?: number | "monthly" | "all_days"
  readonly breakdowns?: readonly string[]
  readonly actionBreakdowns?: readonly string[]
  /** Meta's `filtering` entries, sent as JSON. */
  readonly filtering?: readonly MetaAdsFilter[]
}

export interface MetaAdsFilter {
  readonly field: string
  readonly operator: string
  readonly value: string | number | readonly (string | number)[]
}

export type MetaAdEffectiveStatus =
  | "ACTIVE"
  | "PAUSED"
  | "DELETED"
  | "ARCHIVED"
  | "IN_PROCESS"
  | "WITH_ISSUES"
  | "PENDING_REVIEW"
  | "DISAPPROVED"
  | "PREAPPROVED"
  | "PENDING_BILLING_INFO"
  | "CAMPAIGN_PAUSED"
  | "ADSET_PAUSED"

/**
 * Objects are returned as Meta sends them: the fields below are the defaults and common ones,
 * and any other requested field stays available on the object.
 */
interface MetaAdsObject {
  readonly id: string
  readonly [field: string]: unknown
}

export interface MetaAdAccount extends MetaAdsObject {
  /** `act_<id>`. */
  readonly id: string
  readonly account_id?: string
  readonly name?: string
  /**
   * 1 active, 2 disabled, 3 unsettled, 7 pending risk review, 8 pending settlement, 9 in grace
   * period, 100 pending closure, 101 closed, 201 any active, 202 any closed.
   */
  readonly account_status?: number
  readonly disable_reason?: number
  readonly currency?: string
  readonly timezone_name?: string
  readonly timezone_offset_hours_utc?: number
  readonly created_time?: string
  /** Lifetime spend in the account currency's minor unit, as a string. */
  readonly amount_spent?: string
  /** The business portfolio that owns the account. */
  readonly business?: { readonly id: string; readonly name?: string }
}

export interface MetaPendingAdAccount extends MetaAdsObject {
  readonly ad_account?: MetaAdAccount
  readonly owner_business?: { readonly id: string; readonly name?: string }
}

export interface MetaAdCampaign extends MetaAdsObject {
  readonly name?: string
  readonly objective?: string
  readonly status?: string
  readonly effective_status?: string
  readonly buying_type?: string
  readonly daily_budget?: string
  readonly lifetime_budget?: string
  readonly start_time?: string
  readonly stop_time?: string
  readonly created_time?: string
  readonly updated_time?: string
}

export interface MetaAdSet extends MetaAdsObject {
  readonly campaign_id?: string
  readonly name?: string
  readonly status?: string
  readonly effective_status?: string
  readonly optimization_goal?: string
  readonly billing_event?: string
  readonly daily_budget?: string
  readonly lifetime_budget?: string
  readonly start_time?: string
  readonly end_time?: string
  readonly created_time?: string
  readonly updated_time?: string
}

export interface MetaAd extends MetaAdsObject {
  readonly campaign_id?: string
  readonly adset_id?: string
  readonly name?: string
  readonly status?: string
  readonly effective_status?: string
  readonly creative?: MetaAdCreative
  readonly created_time?: string
  readonly updated_time?: string
}

export interface MetaAdCreative extends MetaAdsObject {
  readonly name?: string
  readonly title?: string
  readonly body?: string
  readonly object_type?: string
  readonly call_to_action_type?: string
  /** Temporary signed URL; copy the image if it must outlive the request. */
  readonly thumbnail_url?: string
  /** Temporary signed URL; copy the image if it must outlive the request. */
  readonly image_url?: string
  readonly video_id?: string
  readonly effective_object_story_id?: string
  readonly instagram_permalink_url?: string
}

/** An Ads Insights action entry, such as `{ action_type: "link_click", value: "12" }`. */
export interface MetaAdsActionValue {
  readonly action_type: string
  readonly value: string
  readonly [attributionWindow: string]: string | undefined
}

/** One entry of the `results` or `cost_per_result` field, as Ads Manager's Results column. */
export interface MetaAdsResult {
  /** What the result counts, such as `actions:link_click`. */
  readonly indicator?: string
  readonly values?: readonly {
    readonly value: string
    readonly attribution_windows?: readonly string[]
  }[]
}

/** One Ads Insights row. Numeric metrics arrive as strings. */
export interface MetaAdsInsight {
  readonly date_start: string
  readonly date_stop: string
  readonly account_id?: string
  readonly account_name?: string
  readonly account_currency?: string
  readonly campaign_id?: string
  readonly campaign_name?: string
  readonly adset_id?: string
  readonly adset_name?: string
  readonly ad_id?: string
  readonly ad_name?: string
  readonly objective?: string
  readonly optimization_goal?: string
  readonly attribution_setting?: string
  readonly spend?: string
  readonly impressions?: string
  readonly reach?: string
  readonly frequency?: string
  readonly clicks?: string
  readonly inline_link_clicks?: string
  readonly actions?: readonly MetaAdsActionValue[]
  readonly action_values?: readonly MetaAdsActionValue[]
  readonly results?: readonly MetaAdsResult[]
  readonly cost_per_result?: readonly MetaAdsResult[]
  readonly [field: string]: unknown
}
