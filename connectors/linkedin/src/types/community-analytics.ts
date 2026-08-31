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

export interface LinkedinFollowerGains {
  readonly organicFollowerGain: number
  readonly paidFollowerGain: number
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
  readonly followerGains?: LinkedinFollowerGains
  readonly timeRange?: LinkedinTimeRange
  [field: string]: unknown
}

export interface LinkedinPageViewMetric {
  readonly pageViews: number
  /** Returned for time-bound metrics when LinkedIn can provide a deduplicated count. */
  readonly uniquePageViews?: number
}

export interface LinkedinPageViews {
  readonly allPageViews?: LinkedinPageViewMetric
  readonly overviewPageViews?: LinkedinPageViewMetric
  readonly careersPageViews?: LinkedinPageViewMetric
  readonly jobsPageViews?: LinkedinPageViewMetric
  readonly peoplePageViews?: LinkedinPageViewMetric
  readonly productsPageViews?: LinkedinPageViewMetric
  [metric: string]: LinkedinPageViewMetric | undefined
}

export interface LinkedinCustomButtonClickCount {
  readonly clicks: number
  readonly customButtonType?: string
  [field: string]: unknown
}

export interface LinkedinPageClicks {
  readonly desktopCustomButtonClickCounts?: readonly LinkedinCustomButtonClickCount[]
  readonly mobileCustomButtonClickCounts?: readonly LinkedinCustomButtonClickCount[]
  [metric: string]: readonly LinkedinCustomButtonClickCount[] | undefined
}

export interface LinkedinPageStatistics {
  readonly views?: LinkedinPageViews
  readonly clicks?: LinkedinPageClicks
  [group: string]: unknown
}

export interface LinkedinPageStatisticFacet {
  readonly pageStatistics: LinkedinPageStatistics
  readonly function?: LinkedinUrn
  readonly geo?: LinkedinUrn
  readonly industry?: LinkedinUrn
  readonly industryV2?: LinkedinUrn
  readonly seniority?: LinkedinUrn
  readonly staffCountRange?: string
  [field: string]: unknown
}

export interface LinkedinOrganizationPageStatistic {
  readonly organization: LinkedinOrganizationUrn
  readonly totalPageStatistics?: LinkedinPageStatistics
  readonly pageStatisticsBySeniority?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByIndustry?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByIndustryV2?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByStaffCountRange?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByFunction?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByGeoCountry?: readonly LinkedinPageStatisticFacet[]
  readonly pageStatisticsByGeo?: readonly LinkedinPageStatisticFacet[]
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
