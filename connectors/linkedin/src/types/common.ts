export type LinkedinId = string | number

export type LinkedinUrn = `urn:li:${string}`
export type LinkedinSponsoredAccountUrn = `urn:li:sponsoredAccount:${string}`
export type LinkedinSponsoredCampaignGroupUrn = `urn:li:sponsoredCampaignGroup:${string}`
export type LinkedinSponsoredCampaignUrn = `urn:li:sponsoredCampaign:${string}`
export type LinkedinSponsoredCreativeUrn = `urn:li:sponsoredCreative:${string}`
export type LinkedinPersonUrn = `urn:li:person:${string}`
export type LinkedinOrganizationUrn = `urn:li:organization:${string}`
export type LinkedinShareUrn = `urn:li:share:${string}`
export type LinkedinUgcPostUrn = `urn:li:ugcPost:${string}`
export type LinkedinPostUrn = LinkedinShareUrn | LinkedinUgcPostUrn
export type LinkedinCommentUrn = `urn:li:comment:${string}`
export type LinkedinReactionUrn = `urn:li:reaction:${string}`
export type LinkedinActivityUrn = `urn:li:activity:${string}`
export type LinkedinImageUrn = `urn:li:image:${string}`
export type LinkedinVideoUrn = `urn:li:video:${string}`
export type LinkedinDocumentUrn = `urn:li:document:${string}`
export type LinkedinDigitalMediaAssetUrn = `urn:li:digitalmediaAsset:${string}`

export type LinkedinSortOrder = "ASCENDING" | "DESCENDING"

export interface LinkedinMoney {
  /** Decimal amount. LinkedIn represents money as a string to preserve precision. */
  readonly amount: string
  /** ISO 4217 currency code. */
  readonly currencyCode: string
}

export interface LinkedinRunSchedule {
  /** Inclusive start time, in milliseconds since the Unix epoch. */
  readonly start: number
  /** Exclusive end time, in milliseconds since the Unix epoch. */
  readonly end?: number
}

export interface LinkedinAuditStamp {
  readonly actor?: LinkedinUrn
  readonly impersonator?: LinkedinUrn
  readonly time: number
}

export interface LinkedinChangeAuditStamps {
  readonly created?: LinkedinAuditStamp
  readonly lastModified?: LinkedinAuditStamp
}

export interface LinkedinVersionTag {
  readonly versionTag: string
}

export interface LinkedinCursorOptions {
  /** Defaults to 100. LinkedIn caps most searches at 1,000 and creative searches at 100. */
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface LinkedinCursorPage<TItem> {
  readonly items: readonly TItem[]
  readonly nextPageToken?: string
  /** Present when the finder supports and receives `isTotalIncluded: true`. */
  readonly totalCount?: number
}

export interface LinkedinPagingLink {
  readonly href?: string
  readonly rel?: string
  readonly type?: string
}

export interface LinkedinPaging {
  readonly start: number
  readonly count: number
  readonly total?: number
  readonly links?: readonly LinkedinPagingLink[]
}

export interface LinkedinOffsetPage<TItem> {
  readonly items: readonly TItem[]
  readonly paging: LinkedinPaging
}

export interface LinkedinOffsetOptions {
  readonly start?: number
  readonly count?: number
}

export interface LinkedinCreatedEntity {
  /** Value returned by LinkedIn in the `x-restli-id` response header. */
  readonly id: string
}

export interface LinkedinCreatedResource<TResource> extends LinkedinCreatedEntity {
  /** Parsed response body returned alongside the Rest.li identifier. */
  readonly data: TResource
}

export interface LinkedinPatch<TFields extends object> {
  readonly $set?: Partial<TFields>
  readonly $delete?: readonly (keyof TFields & string)[]
}

export interface LinkedinDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

export interface LinkedinDateRange {
  readonly start: LinkedinDate
  readonly end?: LinkedinDate
}

export interface LinkedinOptionalDateRange {
  readonly start?: LinkedinDate
  readonly end?: LinkedinDate
}

export interface LinkedinTimeRange {
  /** Inclusive start time, in milliseconds since the Unix epoch. */
  readonly start?: number
  /** Exclusive end time, in milliseconds since the Unix epoch. */
  readonly end?: number
}

export type LinkedinTimeGranularity = "DAY" | "WEEK" | "MONTH"

export interface LinkedinTimeIntervals {
  readonly timeRange: LinkedinTimeRange
  readonly timeGranularityType: LinkedinTimeGranularity
}

export type LinkedinExtensibleString<T extends string> = T | (string & {})
