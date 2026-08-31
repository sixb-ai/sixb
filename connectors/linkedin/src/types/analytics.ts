import type { LinkedinCampaignObjectiveType, LinkedinCampaignType } from "./advertising"
import type {
  LinkedinDateRange,
  LinkedinOrganizationUrn,
  LinkedinSortOrder,
  LinkedinSponsoredAccountUrn,
  LinkedinSponsoredCampaignGroupUrn,
  LinkedinSponsoredCampaignUrn,
  LinkedinUrn,
} from "./common"

export type LinkedinAdAnalyticsPivot =
  | "COMPANY"
  | "ACCOUNT"
  | "SHARE"
  | "CAMPAIGN"
  | "CREATIVE"
  | "CAMPAIGN_GROUP"
  | "CONVERSION"
  | "CONVERSATION_NODE"
  | "CONVERSATION_NODE_OPTION_INDEX"
  | "SERVING_LOCATION"
  | "CARD_INDEX"
  | "MEMBER_COMPANY_SIZE"
  | "MEMBER_INDUSTRY"
  | "MEMBER_SENIORITY"
  | "MEMBER_JOB_TITLE"
  | "MEMBER_JOB_FUNCTION"
  | "MEMBER_COUNTRY_V2"
  | "MEMBER_REGION_V2"
  | "MEMBER_COMPANY"
  | "PLACEMENT_NAME"
  | "IMPRESSION_DEVICE_TYPE"
  | "EVENT_STAGE"
  | "OBJECTIVE_TYPE"

export type LinkedinAdAnalyticsTimeGranularity = "ALL" | "DAILY" | "MONTHLY" | "YEARLY"

export type LinkedinAdAnalyticsSortField =
  | "COST_IN_LOCAL_CURRENCY"
  | "IMPRESSIONS"
  | "CLICKS"
  | "ONE_CLICK_LEADS"
  | "OPENS"
  | "SENDS"
  | "EXTERNAL_WEBSITE_CONVERSIONS"

export interface LinkedinAdAnalyticsFacets {
  readonly shares?: readonly LinkedinUrn[]
  readonly campaigns?: readonly LinkedinSponsoredCampaignUrn[]
  readonly campaignGroups?: readonly LinkedinSponsoredCampaignGroupUrn[]
  readonly accounts?: readonly LinkedinSponsoredAccountUrn[]
  readonly companies?: readonly LinkedinOrganizationUrn[]
}

export interface LinkedinAdAnalyticsQuery extends LinkedinAdAnalyticsFacets {
  readonly pivot: LinkedinAdAnalyticsPivot
  readonly dateRange: LinkedinDateRange
  readonly timeGranularity: LinkedinAdAnalyticsTimeGranularity
  /** Up to 20 metric fields. Values remain open because LinkedIn adds metrics monthly. */
  readonly fields: readonly string[]
  readonly campaignType?: LinkedinCampaignType
  readonly sortBy?: {
    readonly field: LinkedinAdAnalyticsSortField
    readonly order: LinkedinSortOrder
  }
}

export interface LinkedinAdStatisticsQuery extends LinkedinAdAnalyticsFacets {
  /** One to three pivots. */
  readonly pivots: readonly LinkedinAdAnalyticsPivot[]
  readonly dateRange: LinkedinDateRange
  readonly timeGranularity: LinkedinAdAnalyticsTimeGranularity
  /** Up to 20 metric fields. Values remain open because LinkedIn adds metrics monthly. */
  readonly fields: readonly string[]
  readonly objectiveType?: LinkedinCampaignObjectiveType
  readonly campaignType?: LinkedinCampaignType
  readonly sortBy?: {
    readonly field: LinkedinAdAnalyticsSortField
    readonly order: LinkedinSortOrder
  }
}

export interface LinkedinAttributedRevenueQuery {
  readonly pivots: readonly ("ACCOUNT" | "CAMPAIGN_GROUP" | "CAMPAIGN")[]
  readonly account: LinkedinSponsoredAccountUrn
  readonly dateRange: LinkedinDateRange
  readonly campaigns?: readonly LinkedinSponsoredCampaignUrn[]
  readonly campaignGroups?: readonly LinkedinSponsoredCampaignGroupUrn[]
  readonly fields: readonly string[]
}

/**
 * One row returned by `adAnalytics`. Decimal metrics stay strings and all requested metric keys are
 * passed through. Supply a generic row type to a finder when the selected fields are known locally.
 */
export interface LinkedinAdAnalyticsRow {
  readonly dateRange?: LinkedinDateRange
  readonly pivotValues?: readonly string[]
  readonly revenueAttributionMetrics?: LinkedinRevenueAttributionMetrics
  readonly [metric: string]: unknown
}

export interface LinkedinRevenueAttributionMetrics {
  readonly revenueWonInUsd?: string
  readonly returnOnAdSpend?: number
  readonly closedWonOpportunities?: number
  readonly opportunityAmountInUsd?: string
  readonly openOpportunities?: number
  readonly opportunityWinRate?: number
  readonly averageDealSizeInUsd?: string
  readonly averageDaysToClose?: number
}
