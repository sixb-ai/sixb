/**
 * Hand-written public types for Google Analytics Admin API v1beta.
 *
 * Resource shapes stay open because Google supports partial-response selectors
 * and can add output fields without requiring a connector release. Request
 * types name the stable v1beta fields for editor discoverability.
 */
import type { QueryParams } from "./common"

export type AnalyticsPropertyType =
  | "PROPERTY_TYPE_UNSPECIFIED"
  | "PROPERTY_TYPE_ORDINARY"
  | "PROPERTY_TYPE_SUBPROPERTY"
  | "PROPERTY_TYPE_ROLLUP"

export type AnalyticsServiceLevel =
  | "SERVICE_LEVEL_UNSPECIFIED"
  | "GOOGLE_ANALYTICS_STANDARD"
  | "GOOGLE_ANALYTICS_360"

export type AnalyticsIndustryCategory =
  | "INDUSTRY_CATEGORY_UNSPECIFIED"
  | "AUTOMOTIVE"
  | "BUSINESS_AND_INDUSTRIAL_MARKETS"
  | "FINANCE"
  | "HEALTHCARE"
  | "TECHNOLOGY"
  | "TRAVEL"
  | "OTHER"
  | "ARTS_AND_ENTERTAINMENT"
  | "BEAUTY_AND_FITNESS"
  | "BOOKS_AND_LITERATURE"
  | "FOOD_AND_DRINK"
  | "GAMES"
  | "HOBBIES_AND_LEISURE"
  | "HOME_AND_GARDEN"
  | "INTERNET_AND_TELECOM"
  | "LAW_AND_GOVERNMENT"
  | "NEWS"
  | "ONLINE_COMMUNITIES"
  | "PEOPLE_AND_SOCIETY"
  | "PETS_AND_ANIMALS"
  | "REAL_ESTATE"
  | "REFERENCE"
  | "SCIENCE"
  | "SPORTS"
  | "JOBS_AND_EDUCATION"
  | "SHOPPING"

export interface AnalyticsAccount {
  readonly name?: string
  readonly displayName?: string
  readonly regionCode?: string
  readonly createTime?: string
  readonly updateTime?: string
  readonly deleted?: boolean
  readonly gmpOrganization?: string
  readonly [key: string]: unknown
}

export interface AnalyticsPropertySummary {
  readonly property?: string
  readonly displayName?: string
  readonly propertyType?: AnalyticsPropertyType
  readonly parent?: string
  readonly canEdit?: boolean
  readonly [key: string]: unknown
}

export interface AnalyticsAccountSummary {
  readonly name?: string
  readonly account?: string
  readonly displayName?: string
  readonly propertySummaries?: readonly AnalyticsPropertySummary[]
  readonly [key: string]: unknown
}

export interface AnalyticsProperty {
  readonly name?: string
  readonly displayName?: string
  readonly propertyType?: AnalyticsPropertyType
  readonly parent?: string
  readonly account?: string
  readonly industryCategory?: AnalyticsIndustryCategory
  readonly timeZone?: string
  readonly currencyCode?: string
  readonly serviceLevel?: AnalyticsServiceLevel
  readonly createTime?: string
  readonly updateTime?: string
  readonly deleteTime?: string
  readonly expireTime?: string
  readonly [key: string]: unknown
}

export interface AnalyticsDataSharingSettings {
  readonly name?: string
  readonly sharingWithGoogleSupportEnabled?: boolean
  readonly sharingWithGoogleAssignedSalesEnabled?: boolean
  /** Deprecated by Google and always false. */
  readonly sharingWithGoogleAnySalesEnabled?: boolean
  readonly sharingWithGoogleProductsEnabled?: boolean
  readonly sharingWithOthersEnabled?: boolean
  readonly [key: string]: unknown
}

export type AnalyticsRetentionDuration =
  | "RETENTION_DURATION_UNSPECIFIED"
  | "TWO_MONTHS"
  | "FOURTEEN_MONTHS"
  | "TWENTY_SIX_MONTHS"
  | "THIRTY_EIGHT_MONTHS"
  | "FIFTY_MONTHS"

export interface AnalyticsDataRetentionSettings {
  readonly name?: string
  readonly eventDataRetention?: AnalyticsRetentionDuration
  readonly userDataRetention?: AnalyticsRetentionDuration
  readonly resetUserDataOnNewActivity?: boolean
  readonly [key: string]: unknown
}

export type AnalyticsDataStreamType =
  | "DATA_STREAM_TYPE_UNSPECIFIED"
  | "WEB_DATA_STREAM"
  | "ANDROID_APP_DATA_STREAM"
  | "IOS_APP_DATA_STREAM"

export interface AnalyticsWebStreamData {
  readonly measurementId?: string
  readonly firebaseAppId?: string
  readonly defaultUri?: string
  readonly [key: string]: unknown
}

export interface AnalyticsAndroidAppStreamData {
  readonly firebaseAppId?: string
  readonly packageName?: string
  readonly [key: string]: unknown
}

export interface AnalyticsIosAppStreamData {
  readonly firebaseAppId?: string
  readonly bundleId?: string
  readonly [key: string]: unknown
}

export interface AnalyticsDataStream {
  readonly name?: string
  readonly type?: AnalyticsDataStreamType
  readonly displayName?: string
  readonly createTime?: string
  readonly updateTime?: string
  readonly webStreamData?: AnalyticsWebStreamData
  readonly androidAppStreamData?: AnalyticsAndroidAppStreamData
  readonly iosAppStreamData?: AnalyticsIosAppStreamData
  readonly [key: string]: unknown
}

export type AnalyticsCustomDimensionScope =
  | "DIMENSION_SCOPE_UNSPECIFIED"
  | "EVENT"
  | "USER"
  | "ITEM"

export interface AnalyticsCustomDimension {
  readonly name?: string
  readonly parameterName?: string
  readonly displayName?: string
  readonly description?: string
  readonly scope?: AnalyticsCustomDimensionScope
  readonly disallowAdsPersonalization?: boolean
  readonly [key: string]: unknown
}

export type AnalyticsMetricScope = "METRIC_SCOPE_UNSPECIFIED" | "EVENT"
export type AnalyticsMeasurementUnit =
  | "MEASUREMENT_UNIT_UNSPECIFIED"
  | "STANDARD"
  | "CURRENCY"
  | "FEET"
  | "METERS"
  | "KILOMETERS"
  | "MILES"
  | "MILLISECONDS"
  | "SECONDS"
  | "MINUTES"
  | "HOURS"
export type AnalyticsRestrictedMetricType =
  | "RESTRICTED_METRIC_TYPE_UNSPECIFIED"
  | "COST_DATA"
  | "REVENUE_DATA"

export interface AnalyticsCustomMetric {
  readonly name?: string
  readonly parameterName?: string
  readonly displayName?: string
  readonly description?: string
  readonly scope?: AnalyticsMetricScope
  readonly measurementUnit?: AnalyticsMeasurementUnit
  readonly restrictedMetricType?: readonly AnalyticsRestrictedMetricType[]
  readonly [key: string]: unknown
}

export interface AnalyticsMeasurementProtocolSecret {
  readonly name?: string
  readonly displayName?: string
  readonly secretValue?: string
  readonly [key: string]: unknown
}

export interface AnalyticsFirebaseLink {
  readonly name?: string
  readonly project?: string
  readonly createTime?: string
  readonly [key: string]: unknown
}

export interface AnalyticsGoogleAdsLink {
  readonly name?: string
  readonly customerId?: string
  readonly canManageClients?: boolean
  readonly adsPersonalizationEnabled?: boolean
  readonly creatorEmailAddress?: string
  readonly createTime?: string
  readonly updateTime?: string
  readonly [key: string]: unknown
}

export type AnalyticsKeyEventCountingMethod =
  | "COUNTING_METHOD_UNSPECIFIED"
  | "ONCE_PER_EVENT"
  | "ONCE_PER_SESSION"

export interface AnalyticsKeyEventDefaultValue {
  readonly numericValue?: number
  readonly currencyCode?: string
}

export interface AnalyticsKeyEvent {
  readonly name?: string
  readonly eventName?: string
  readonly createTime?: string
  readonly deletable?: boolean
  readonly custom?: boolean
  readonly countingMethod?: AnalyticsKeyEventCountingMethod
  readonly defaultValue?: AnalyticsKeyEventDefaultValue
  readonly [key: string]: unknown
}

export type AnalyticsChangeAction = "ACTION_TYPE_UNSPECIFIED" | "CREATED" | "UPDATED" | "DELETED"

export type AnalyticsChangeActorType = "ACTOR_TYPE_UNSPECIFIED" | "USER" | "SYSTEM" | "SUPPORT"

export type AnalyticsChangeResourceType =
  | "CHANGE_HISTORY_RESOURCE_TYPE_UNSPECIFIED"
  | "ACCOUNT"
  | "PROPERTY"
  | "FIREBASE_LINK"
  | "GOOGLE_ADS_LINK"
  | "GOOGLE_SIGNALS_SETTINGS"
  | "CONVERSION_EVENT"
  | "MEASUREMENT_PROTOCOL_SECRET"
  | "CUSTOM_DIMENSION"
  | "CUSTOM_METRIC"
  | "DATA_RETENTION_SETTINGS"
  | "DISPLAY_VIDEO_360_ADVERTISER_LINK"
  | "DISPLAY_VIDEO_360_ADVERTISER_LINK_PROPOSAL"
  | "DATA_STREAM"
  | "ATTRIBUTION_SETTINGS"

export interface AnalyticsChangeHistoryResource {
  readonly account?: AnalyticsAccount
  readonly property?: AnalyticsProperty
  readonly dataStream?: AnalyticsDataStream
  readonly firebaseLink?: AnalyticsFirebaseLink
  readonly googleAdsLink?: AnalyticsGoogleAdsLink
  readonly measurementProtocolSecret?: AnalyticsMeasurementProtocolSecret
  readonly dataRetentionSettings?: AnalyticsDataRetentionSettings
  readonly [key: string]: unknown
}

export interface AnalyticsChangeHistoryChange {
  readonly resource?: string
  readonly action?: AnalyticsChangeAction
  readonly resourceBeforeChange?: AnalyticsChangeHistoryResource
  readonly resourceAfterChange?: AnalyticsChangeHistoryResource
  readonly [key: string]: unknown
}

export interface AnalyticsChangeHistoryEvent {
  readonly id?: string
  readonly changeTime?: string
  readonly actorType?: AnalyticsChangeActorType
  readonly userActorEmail?: string
  readonly changesFiltered?: boolean
  readonly changes?: readonly AnalyticsChangeHistoryChange[]
  readonly [key: string]: unknown
}

export interface AnalyticsNumericValue {
  readonly int64Value?: string
  readonly doubleValue?: number
}

export interface AnalyticsAccessDateRange {
  readonly startDate?: string
  readonly endDate?: string
}

export interface AnalyticsAccessDimension {
  readonly dimensionName?: string
}

export interface AnalyticsAccessMetric {
  readonly metricName?: string
}

export interface AnalyticsAccessStringFilter {
  readonly matchType?:
    | "MATCH_TYPE_UNSPECIFIED"
    | "EXACT"
    | "BEGINS_WITH"
    | "ENDS_WITH"
    | "CONTAINS"
    | "FULL_REGEXP"
    | "PARTIAL_REGEXP"
  readonly value?: string
  readonly caseSensitive?: boolean
}

export interface AnalyticsAccessInListFilter {
  readonly values?: readonly string[]
  readonly caseSensitive?: boolean
}

export interface AnalyticsAccessNumericFilter {
  readonly operation?:
    | "OPERATION_UNSPECIFIED"
    | "EQUAL"
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
  readonly value?: AnalyticsNumericValue
}

export interface AnalyticsAccessBetweenFilter {
  readonly fromValue?: AnalyticsNumericValue
  readonly toValue?: AnalyticsNumericValue
}

export interface AnalyticsAccessFilter {
  readonly fieldName?: string
  readonly stringFilter?: AnalyticsAccessStringFilter
  readonly inListFilter?: AnalyticsAccessInListFilter
  readonly numericFilter?: AnalyticsAccessNumericFilter
  readonly betweenFilter?: AnalyticsAccessBetweenFilter
}

export interface AnalyticsAccessFilterExpressionList {
  readonly expressions?: readonly AnalyticsAccessFilterExpression[]
}

export interface AnalyticsAccessFilterExpression {
  readonly andGroup?: AnalyticsAccessFilterExpressionList
  readonly orGroup?: AnalyticsAccessFilterExpressionList
  readonly notExpression?: AnalyticsAccessFilterExpression
  readonly accessFilter?: AnalyticsAccessFilter
}

export interface AnalyticsAccessOrderBy {
  readonly desc?: boolean
  readonly metric?: { readonly metricName?: string }
  readonly dimension?: {
    readonly dimensionName?: string
    readonly orderType?:
      | "ORDER_TYPE_UNSPECIFIED"
      | "ALPHANUMERIC"
      | "CASE_INSENSITIVE_ALPHANUMERIC"
      | "NUMERIC"
  }
}

export interface AnalyticsAccessDimensionHeader {
  readonly dimensionName?: string
}

export interface AnalyticsAccessMetricHeader {
  readonly metricName?: string
}

export interface AnalyticsAccessDimensionValue {
  readonly value?: string
}

export interface AnalyticsAccessMetricValue {
  readonly value?: string
}

export interface AnalyticsAccessRow {
  readonly dimensionValues?: readonly AnalyticsAccessDimensionValue[]
  readonly metricValues?: readonly AnalyticsAccessMetricValue[]
}

export interface AnalyticsAccessQuotaStatus {
  readonly consumed?: number
  readonly remaining?: number
}

export interface AnalyticsAccessQuota {
  readonly tokensPerDay?: AnalyticsAccessQuotaStatus
  readonly tokensPerHour?: AnalyticsAccessQuotaStatus
  readonly tokensPerProjectPerHour?: AnalyticsAccessQuotaStatus
  readonly concurrentRequests?: AnalyticsAccessQuotaStatus
  readonly serverErrorsPerProjectPerHour?: AnalyticsAccessQuotaStatus
}

export interface AnalyticsRunAccessReportRequest {
  readonly dimensions?: readonly AnalyticsAccessDimension[]
  readonly metrics?: readonly AnalyticsAccessMetric[]
  readonly dateRanges?: readonly AnalyticsAccessDateRange[]
  readonly dimensionFilter?: AnalyticsAccessFilterExpression
  readonly metricFilter?: AnalyticsAccessFilterExpression
  readonly offset?: string
  readonly limit?: string
  readonly timeZone?: string
  readonly orderBys?: readonly AnalyticsAccessOrderBy[]
  readonly returnEntityQuota?: boolean
  readonly includeAllUsers?: boolean
  readonly expandGroups?: boolean
}

export interface AnalyticsRunAccessReportResponse {
  readonly dimensionHeaders?: readonly AnalyticsAccessDimensionHeader[]
  readonly metricHeaders?: readonly AnalyticsAccessMetricHeader[]
  readonly rows?: readonly AnalyticsAccessRow[]
  readonly rowCount?: number
  readonly quota?: AnalyticsAccessQuota
}

export interface AnalyticsSearchChangeHistoryRequest {
  readonly property?: string
  readonly resourceType?: readonly AnalyticsChangeResourceType[]
  readonly action?: readonly AnalyticsChangeAction[]
  readonly actorEmail?: readonly string[]
  readonly earliestChangeTime?: string
  readonly latestChangeTime?: string
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface AnalyticsSearchChangeHistoryResponse {
  readonly changeHistoryEvents?: readonly AnalyticsChangeHistoryEvent[]
  readonly nextPageToken?: string
}

export interface AnalyticsListAccountSummariesResponse {
  readonly accountSummaries?: readonly AnalyticsAccountSummary[]
  readonly nextPageToken?: string
}

export interface AnalyticsListAccountsResponse {
  readonly accounts?: readonly AnalyticsAccount[]
  readonly nextPageToken?: string
}

export interface AnalyticsListPropertiesResponse {
  readonly properties?: readonly AnalyticsProperty[]
  readonly nextPageToken?: string
}

export interface AnalyticsListCustomDimensionsResponse {
  readonly customDimensions?: readonly AnalyticsCustomDimension[]
  readonly nextPageToken?: string
}

export interface AnalyticsListCustomMetricsResponse {
  readonly customMetrics?: readonly AnalyticsCustomMetric[]
  readonly nextPageToken?: string
}

export interface AnalyticsListDataStreamsResponse {
  readonly dataStreams?: readonly AnalyticsDataStream[]
  readonly nextPageToken?: string
}

export interface AnalyticsListMeasurementProtocolSecretsResponse {
  readonly measurementProtocolSecrets?: readonly AnalyticsMeasurementProtocolSecret[]
  readonly nextPageToken?: string
}

export interface AnalyticsListFirebaseLinksResponse {
  readonly firebaseLinks?: readonly AnalyticsFirebaseLink[]
  readonly nextPageToken?: string
}

export interface AnalyticsListGoogleAdsLinksResponse {
  readonly googleAdsLinks?: readonly AnalyticsGoogleAdsLink[]
  readonly nextPageToken?: string
}

export interface AnalyticsListKeyEventsResponse {
  readonly keyEvents?: readonly AnalyticsKeyEvent[]
  readonly nextPageToken?: string
}

export type AnalyticsPageOptions = QueryParams & {
  readonly pageSize?: number
  readonly pageToken?: string
}

export type AnalyticsAccountListOptions = AnalyticsPageOptions & {
  readonly showDeleted?: boolean
}

export type AnalyticsPropertyListOptions = AnalyticsPageOptions & {
  /** Required, e.g. `parent:accounts/123` or `ancestor:accounts/123`. */
  readonly filter: string
  readonly showDeleted?: boolean
}

export type AnalyticsUpdateOptions = QueryParams & {
  /** Required Google field mask. Field names use snake_case. */
  readonly updateMask: string
}

export type AnalyticsCustomDimensionListOptions = AnalyticsPageOptions
export type AnalyticsCustomMetricListOptions = AnalyticsPageOptions
export type AnalyticsDataStreamListOptions = AnalyticsPageOptions
export type AnalyticsMeasurementProtocolSecretListOptions = AnalyticsPageOptions
export type AnalyticsFirebaseLinkListOptions = AnalyticsPageOptions
export type AnalyticsGoogleAdsLinkListOptions = AnalyticsPageOptions
export type AnalyticsKeyEventListOptions = AnalyticsPageOptions

export interface AnalyticsProvisionAccountTicketRequest {
  readonly account: AnalyticsAccount
  readonly redirectUri: string
}

export interface AnalyticsProvisionAccountTicketResponse {
  readonly accountTicketId?: string
}

export interface AnalyticsAcknowledgeUserDataCollectionRequest {
  readonly acknowledgement: string
}
