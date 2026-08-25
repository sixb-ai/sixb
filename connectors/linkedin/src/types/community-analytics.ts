import type {
  LinkedinDateRange,
  LinkedinExtensibleString,
  LinkedinOptionalDateRange,
  LinkedinOrganizationUrn,
  LinkedinPostUrn,
  LinkedinTimeIntervals,
  LinkedinTimeRange,
  LinkedinUgcPostUrn,
  LinkedinUrn,
} from "./common"

export interface LinkedinFollowerCounts {
  /** For demographic facets, LinkedIn rolls organic and paid followers into this field. */
  readonly organicFollowerCount: number
  readonly paidFollowerCount: number
}

export interface LinkedinFollowerFacetCount {
  readonly followerCounts: LinkedinFollowerCounts
  readonly associationType?: string
  readonly function?: LinkedinUrn
  readonly geo?: LinkedinUrn
  readonly industry?: LinkedinUrn
  readonly seniority?: LinkedinUrn
  readonly staffCountRange?: string
  [field: string]: unknown
}

export interface LinkedinOrganizationFollowerStatistic {
  readonly organizationalEntity: LinkedinOrganizationUrn
  readonly followerCountsByAssociationType?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsByFunction?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsByGeo?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsByGeoCountry?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsByIndustry?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsBySeniority?: readonly LinkedinFollowerFacetCount[]
  readonly followerCountsByStaffCountRange?: readonly LinkedinFollowerFacetCount[]
  readonly followerGains?: LinkedinFollowerCounts
  readonly timeRange?: LinkedinTimeRange
  [field: string]: unknown
}

export interface LinkedinPageViews {
  readonly allPageViews?: number
  readonly overviewPageViews?: number
  readonly careersPageViews?: number
  readonly jobsPageViews?: number
  readonly peoplePageViews?: number
  readonly productsPageViews?: number
  readonly uniquePageViews?: number
  [metric: string]: number | undefined
}

export interface LinkedinPageClicks {
  readonly careersPageClicks?: number
  readonly careersPagePromoLinksClicks?: number
  readonly customButtonClicks?: number
  readonly desktopCustomButtonClicks?: number
  readonly mobileCustomButtonClicks?: number
  [metric: string]: number | undefined
}

export interface LinkedinPageStatistics {
  readonly views?: LinkedinPageViews
  readonly clicks?: LinkedinPageClicks
  [group: string]: unknown
}

export interface LinkedinOrganizationPageStatistic {
  readonly organization: LinkedinOrganizationUrn
  readonly totalPageStatistics?: LinkedinPageStatistics
  readonly pageStatisticsBySeniority?: readonly Readonly<Record<string, unknown>>[]
  readonly pageStatisticsByIndustry?: readonly Readonly<Record<string, unknown>>[]
  readonly pageStatisticsByStaffCountRange?: readonly Readonly<Record<string, unknown>>[]
  readonly pageStatisticsByFunction?: readonly Readonly<Record<string, unknown>>[]
  readonly pageStatisticsByGeoCountry?: readonly Readonly<Record<string, unknown>>[]
  readonly pageStatisticsByGeo?: readonly Readonly<Record<string, unknown>>[]
  readonly timeRange?: LinkedinTimeRange
  [field: string]: unknown
}

export interface LinkedinShareStatistics {
  readonly clickCount: number
  readonly commentCount: number
  readonly engagement: number
  readonly impressionCount: number
  readonly likeCount: number
  readonly shareCount: number
  readonly uniqueImpressionsCount?: number
  readonly uniqueImpressionsCounts?: number
  [metric: string]: number | undefined
}

export interface LinkedinOrganizationShareStatistic {
  readonly organizationalEntity: LinkedinOrganizationUrn
  readonly totalShareStatistics: LinkedinShareStatistics
  readonly share?: LinkedinPostUrn
  readonly ugcPost?: LinkedinUgcPostUrn
  readonly timeRange?: LinkedinTimeRange
  [field: string]: unknown
}

export type LinkedinOrganizationVideoMetric =
  | "VIDEO_VIEW"
  | "VIEWER"
  | "TIME_WATCHED"
  | "TIME_WATCHED_FOR_VIDEO_VIEWS"

export type LinkedinOrganizationVideoAggregation = "DAY" | "WEEK" | "ALL"

export interface LinkedinOrganizationVideoAnalyticsQuery {
  readonly entity: LinkedinUgcPostUrn
  readonly type: LinkedinOrganizationVideoMetric
  readonly aggregation?: LinkedinOrganizationVideoAggregation
  readonly timeRange?: LinkedinTimeRange
}

export interface LinkedinOrganizationVideoStatistic {
  readonly entity: LinkedinUgcPostUrn
  readonly value: number
  readonly type?: LinkedinOrganizationVideoMetric
  readonly statisticsType?: LinkedinOrganizationVideoMetric
  readonly timeRange?: LinkedinTimeRange
  [field: string]: unknown
}

export interface LinkedinOrganizationShareStatisticsQuery {
  readonly timeIntervals?: LinkedinTimeIntervals
  /** Specific posts cannot be combined with `timeIntervals`. */
  readonly posts?: readonly LinkedinPostUrn[]
}

export type LinkedinMemberPostMetric = LinkedinExtensibleString<
  | "IMPRESSION"
  | "MEMBERS_REACHED"
  | "RESHARE"
  | "REACTION"
  | "COMMENT"
  | "POST_SAVE"
  | "POST_SEND"
  | "LINK_CLICKS"
  | "PREMIUM_CTA_CLICKS"
  | "FOLLOWER_GAINED_FROM_CONTENT"
  | "PROFILE_VIEW_FROM_CONTENT"
>

export type LinkedinMemberAnalyticsAggregation = "DAILY" | "TOTAL"

export interface LinkedinMemberPostAnalyticsQuery {
  readonly queryType: LinkedinMemberPostMetric
  readonly aggregation?: LinkedinMemberAnalyticsAggregation
  readonly dateRange?: LinkedinOptionalDateRange
}

export interface LinkedinMemberPostEntityAnalyticsQuery extends LinkedinMemberPostAnalyticsQuery {
  readonly entity: LinkedinPostUrn
}

export interface LinkedinMemberPostStatistic {
  readonly count: number
  readonly metricType: LinkedinMemberPostMetric | Readonly<Record<string, LinkedinMemberPostMetric>>
  readonly targetEntity?: { readonly share: LinkedinPostUrn } | { readonly ugc: LinkedinPostUrn }
  readonly dateRange?: LinkedinDateRange
  [field: string]: unknown
}

export interface LinkedinMemberFollowerStatistic {
  readonly memberFollowersCount: number
  readonly dateRange?: LinkedinDateRange
  [field: string]: unknown
}

export type LinkedinMemberVideoMetric = "VIDEO_PLAY" | "VIDEO_VIEWER" | "VIDEO_WATCH_TIME"

export interface LinkedinMemberVideoAnalyticsQuery {
  readonly entity: LinkedinPostUrn
  readonly queryType: LinkedinMemberVideoMetric
  readonly aggregation?: LinkedinMemberAnalyticsAggregation
  readonly dateRange?: LinkedinOptionalDateRange
}

export interface LinkedinMemberVideoStatistic {
  readonly count: number
  readonly metricType:
    | LinkedinMemberVideoMetric
    | Readonly<Record<string, LinkedinMemberVideoMetric>>
  readonly targetEntity: { readonly share: LinkedinPostUrn } | { readonly ugc: LinkedinPostUrn }
  readonly dateRange?: LinkedinDateRange
  [field: string]: unknown
}
