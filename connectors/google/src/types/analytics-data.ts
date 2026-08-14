export type AnalyticsMetricAggregation =
  | "METRIC_AGGREGATION_UNSPECIFIED"
  | "TOTAL"
  | "MINIMUM"
  | "MAXIMUM"
  | "COUNT"

export type AnalyticsCompatibility = "COMPATIBILITY_UNSPECIFIED" | "COMPATIBLE" | "INCOMPATIBLE"

export type AnalyticsMetricType =
  | "METRIC_TYPE_UNSPECIFIED"
  | "TYPE_INTEGER"
  | "TYPE_FLOAT"
  | "TYPE_SECONDS"
  | "TYPE_MILLISECONDS"
  | "TYPE_MINUTES"
  | "TYPE_HOURS"
  | "TYPE_STANDARD"
  | "TYPE_CURRENCY"
  | "TYPE_FEET"
  | "TYPE_MILES"
  | "TYPE_METERS"
  | "TYPE_KILOMETERS"

export interface AnalyticsDataDimension {
  readonly name?: string
  readonly dimensionExpression?: AnalyticsDataDimensionExpression
}

export interface AnalyticsDataDimensionExpression {
  readonly lowerCase?: AnalyticsDataCaseExpression
  readonly upperCase?: AnalyticsDataCaseExpression
  readonly concatenate?: AnalyticsDataConcatenateExpression
}

export interface AnalyticsDataCaseExpression {
  readonly dimensionName?: string
}

export interface AnalyticsDataConcatenateExpression {
  readonly dimensionNames?: readonly string[]
  readonly delimiter?: string
}

export interface AnalyticsDataMetric {
  readonly name?: string
  readonly expression?: string
  readonly invisible?: boolean
}

export interface AnalyticsDataDateRange {
  readonly startDate?: string
  readonly endDate?: string
  readonly name?: string
}

export interface AnalyticsDataMinuteRange {
  readonly startMinutesAgo?: number
  readonly endMinutesAgo?: number
  readonly name?: string
}

export interface AnalyticsDataFilterExpression {
  readonly andGroup?: AnalyticsDataFilterExpressionList
  readonly orGroup?: AnalyticsDataFilterExpressionList
  readonly notExpression?: AnalyticsDataFilterExpression
  readonly filter?: AnalyticsDataFilter
}

export interface AnalyticsDataFilterExpressionList {
  readonly expressions?: readonly AnalyticsDataFilterExpression[]
}

export interface AnalyticsDataFilter {
  readonly fieldName?: string
  readonly stringFilter?: AnalyticsDataStringFilter
  readonly inListFilter?: AnalyticsDataInListFilter
  readonly numericFilter?: AnalyticsDataNumericFilter
  readonly betweenFilter?: AnalyticsDataBetweenFilter
  readonly emptyFilter?: Record<string, never>
}

export interface AnalyticsDataStringFilter {
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

export interface AnalyticsDataInListFilter {
  readonly values?: readonly string[]
  readonly caseSensitive?: boolean
}

export interface AnalyticsDataNumericFilter {
  readonly operation?:
    | "OPERATION_UNSPECIFIED"
    | "EQUAL"
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
  readonly value?: AnalyticsDataNumericValue
}

export interface AnalyticsDataNumericValue {
  readonly int64Value?: string
  readonly doubleValue?: number
}

export interface AnalyticsDataBetweenFilter {
  readonly fromValue?: AnalyticsDataNumericValue
  readonly toValue?: AnalyticsDataNumericValue
}

export interface AnalyticsDataOrderBy {
  readonly metric?: AnalyticsDataMetricOrderBy
  readonly dimension?: AnalyticsDataDimensionOrderBy
  readonly pivot?: AnalyticsDataPivotOrderBy
  readonly desc?: boolean
}

export interface AnalyticsDataMetricOrderBy {
  readonly metricName?: string
}

export interface AnalyticsDataDimensionOrderBy {
  readonly dimensionName?: string
  readonly orderType?:
    | "ORDER_TYPE_UNSPECIFIED"
    | "ALPHANUMERIC"
    | "CASE_INSENSITIVE_ALPHANUMERIC"
    | "NUMERIC"
}

export interface AnalyticsDataPivotOrderBy {
  readonly metricName?: string
  readonly pivotSelections?: readonly AnalyticsDataPivotSelection[]
}

export interface AnalyticsDataPivotSelection {
  readonly dimensionName?: string
  readonly dimensionValue?: string
}

export interface AnalyticsDataComparison {
  readonly name?: string
  readonly dimensionFilter?: AnalyticsDataFilterExpression
  readonly comparison?: string
}

export interface AnalyticsDataCohortSpec {
  readonly cohorts?: readonly AnalyticsDataCohort[]
  readonly cohortsRange?: AnalyticsDataCohortsRange
  readonly cohortReportSettings?: AnalyticsDataCohortReportSettings
}

export interface AnalyticsDataCohort {
  readonly name?: string
  readonly dimension?: string
  readonly dateRange?: AnalyticsDataDateRange
}

export interface AnalyticsDataCohortsRange {
  readonly granularity?: "GRANULARITY_UNSPECIFIED" | "DAILY" | "WEEKLY" | "MONTHLY"
  readonly startOffset?: number
  readonly endOffset?: number
}

export interface AnalyticsDataCohortReportSettings {
  readonly accumulate?: boolean
}

export interface AnalyticsRunReportRequest {
  readonly property?: string
  readonly dimensions?: readonly AnalyticsDataDimension[]
  readonly metrics?: readonly AnalyticsDataMetric[]
  readonly dateRanges?: readonly AnalyticsDataDateRange[]
  readonly dimensionFilter?: AnalyticsDataFilterExpression
  readonly metricFilter?: AnalyticsDataFilterExpression
  readonly offset?: string
  readonly limit?: string
  readonly metricAggregations?: readonly AnalyticsMetricAggregation[]
  readonly orderBys?: readonly AnalyticsDataOrderBy[]
  readonly currencyCode?: string
  readonly cohortSpec?: AnalyticsDataCohortSpec
  readonly keepEmptyRows?: boolean
  readonly returnPropertyQuota?: boolean
  readonly comparisons?: readonly AnalyticsDataComparison[]
}

export interface AnalyticsRunPivotReportRequest {
  readonly property?: string
  readonly dimensions?: readonly AnalyticsDataDimension[]
  readonly metrics?: readonly AnalyticsDataMetric[]
  readonly dateRanges?: readonly AnalyticsDataDateRange[]
  readonly pivots?: readonly AnalyticsDataPivot[]
  readonly dimensionFilter?: AnalyticsDataFilterExpression
  readonly metricFilter?: AnalyticsDataFilterExpression
  readonly currencyCode?: string
  readonly cohortSpec?: AnalyticsDataCohortSpec
  readonly keepEmptyRows?: boolean
  readonly returnPropertyQuota?: boolean
  readonly comparisons?: readonly AnalyticsDataComparison[]
}

export interface AnalyticsDataPivot {
  readonly fieldNames?: readonly string[]
  readonly orderBys?: readonly AnalyticsDataOrderBy[]
  readonly offset?: string
  readonly limit?: string
  readonly metricAggregations?: readonly AnalyticsMetricAggregation[]
}

export interface AnalyticsRunRealtimeReportRequest {
  readonly dimensions?: readonly AnalyticsDataDimension[]
  readonly metrics?: readonly AnalyticsDataMetric[]
  readonly dimensionFilter?: AnalyticsDataFilterExpression
  readonly metricFilter?: AnalyticsDataFilterExpression
  readonly limit?: string
  readonly metricAggregations?: readonly AnalyticsMetricAggregation[]
  readonly orderBys?: readonly AnalyticsDataOrderBy[]
  readonly returnPropertyQuota?: boolean
  readonly minuteRanges?: readonly AnalyticsDataMinuteRange[]
}

export interface AnalyticsDataDimensionHeader {
  readonly name?: string
}

export interface AnalyticsDataMetricHeader {
  readonly name?: string
  readonly type?: AnalyticsMetricType
}

export interface AnalyticsDataDimensionValue {
  readonly value?: string
}

export interface AnalyticsDataMetricValue {
  readonly value?: string
}

export interface AnalyticsDataRow {
  readonly dimensionValues?: readonly AnalyticsDataDimensionValue[]
  readonly metricValues?: readonly AnalyticsDataMetricValue[]
}

export interface AnalyticsDataResponseMetadata {
  readonly dataLossFromOtherRow?: boolean
  readonly schemaRestrictionResponse?: AnalyticsDataSchemaRestrictionResponse
  readonly currencyCode?: string
  readonly timeZone?: string
  readonly emptyReason?: string
  readonly subjectToThresholding?: boolean
  readonly samplingMetadatas?: readonly AnalyticsDataSamplingMetadata[]
}

export interface AnalyticsDataSamplingMetadata {
  readonly samplesReadCount?: string
  readonly samplingSpaceSize?: string
}

export interface AnalyticsDataSchemaRestrictionResponse {
  readonly activeMetricRestrictions?: readonly AnalyticsDataActiveMetricRestriction[]
}

export interface AnalyticsDataActiveMetricRestriction {
  readonly metricName?: string
  readonly restrictedMetricTypes?: readonly (
    | "RESTRICTED_METRIC_TYPE_UNSPECIFIED"
    | "COST_DATA"
    | "REVENUE_DATA"
  )[]
}

export interface AnalyticsDataQuotaStatus {
  readonly consumed?: number
  readonly remaining?: number
}

export interface AnalyticsDataPropertyQuota {
  readonly tokensPerDay?: AnalyticsDataQuotaStatus
  readonly tokensPerHour?: AnalyticsDataQuotaStatus
  readonly concurrentRequests?: AnalyticsDataQuotaStatus
  readonly serverErrorsPerProjectPerHour?: AnalyticsDataQuotaStatus
  readonly potentiallyThresholdedRequestsPerHour?: AnalyticsDataQuotaStatus
  readonly tokensPerProjectPerHour?: AnalyticsDataQuotaStatus
}

export interface AnalyticsRunReportResponse {
  readonly dimensionHeaders?: readonly AnalyticsDataDimensionHeader[]
  readonly metricHeaders?: readonly AnalyticsDataMetricHeader[]
  readonly rows?: readonly AnalyticsDataRow[]
  readonly totals?: readonly AnalyticsDataRow[]
  readonly maximums?: readonly AnalyticsDataRow[]
  readonly minimums?: readonly AnalyticsDataRow[]
  readonly rowCount?: number
  readonly metadata?: AnalyticsDataResponseMetadata
  readonly propertyQuota?: AnalyticsDataPropertyQuota
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface AnalyticsDataPivotDimensionHeader {
  readonly dimensionValues?: readonly AnalyticsDataDimensionValue[]
}

export interface AnalyticsDataPivotHeader {
  readonly pivotDimensionHeaders?: readonly AnalyticsDataPivotDimensionHeader[]
  readonly rowCount?: number
}

export interface AnalyticsRunPivotReportResponse {
  readonly pivotHeaders?: readonly AnalyticsDataPivotHeader[]
  readonly dimensionHeaders?: readonly AnalyticsDataDimensionHeader[]
  readonly metricHeaders?: readonly AnalyticsDataMetricHeader[]
  readonly rows?: readonly AnalyticsDataRow[]
  readonly aggregates?: readonly AnalyticsDataRow[]
  readonly metadata?: AnalyticsDataResponseMetadata
  readonly propertyQuota?: AnalyticsDataPropertyQuota
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface AnalyticsRunRealtimeReportResponse {
  readonly dimensionHeaders?: readonly AnalyticsDataDimensionHeader[]
  readonly metricHeaders?: readonly AnalyticsDataMetricHeader[]
  readonly rows?: readonly AnalyticsDataRow[]
  readonly totals?: readonly AnalyticsDataRow[]
  readonly maximums?: readonly AnalyticsDataRow[]
  readonly minimums?: readonly AnalyticsDataRow[]
  readonly rowCount?: number
  readonly propertyQuota?: AnalyticsDataPropertyQuota
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface AnalyticsBatchRunReportsRequest {
  readonly requests: readonly AnalyticsRunReportRequest[]
}

export interface AnalyticsBatchRunReportsResponse {
  readonly reports?: readonly AnalyticsRunReportResponse[]
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface AnalyticsBatchRunPivotReportsRequest {
  readonly requests: readonly AnalyticsRunPivotReportRequest[]
}

export interface AnalyticsBatchRunPivotReportsResponse {
  readonly pivotReports?: readonly AnalyticsRunPivotReportResponse[]
  readonly kind?: string
  readonly [key: string]: unknown
}

export interface AnalyticsDimensionMetadata {
  readonly apiName?: string
  readonly uiName?: string
  readonly description?: string
  readonly deprecatedApiNames?: readonly string[]
  readonly customDefinition?: boolean
  readonly category?: string
}

export interface AnalyticsMetricMetadata extends AnalyticsDimensionMetadata {
  readonly expression?: string
  readonly type?: AnalyticsMetricType
  readonly blockedReasons?: readonly (
    | "BLOCKED_REASON_UNSPECIFIED"
    | "NO_REVENUE_METRICS"
    | "NO_COST_METRICS"
  )[]
}

export interface AnalyticsComparisonMetadata {
  readonly apiName?: string
  readonly uiName?: string
  readonly description?: string
}

export interface AnalyticsDataMetadata {
  readonly name?: string
  readonly dimensions?: readonly AnalyticsDimensionMetadata[]
  readonly metrics?: readonly AnalyticsMetricMetadata[]
  readonly comparisons?: readonly AnalyticsComparisonMetadata[]
  readonly [key: string]: unknown
}

export interface AnalyticsCheckCompatibilityRequest {
  readonly dimensions?: readonly AnalyticsDataDimension[]
  readonly metrics?: readonly AnalyticsDataMetric[]
  readonly dimensionFilter?: AnalyticsDataFilterExpression
  readonly metricFilter?: AnalyticsDataFilterExpression
  readonly compatibilityFilter?: AnalyticsCompatibility
}

export interface AnalyticsDimensionCompatibility {
  readonly dimensionMetadata?: AnalyticsDimensionMetadata
  readonly compatibility?: AnalyticsCompatibility
}

export interface AnalyticsMetricCompatibility {
  readonly metricMetadata?: AnalyticsMetricMetadata
  readonly compatibility?: AnalyticsCompatibility
}

export interface AnalyticsCheckCompatibilityResponse {
  readonly dimensionCompatibilities?: readonly AnalyticsDimensionCompatibility[]
  readonly metricCompatibilities?: readonly AnalyticsMetricCompatibility[]
  readonly [key: string]: unknown
}

export interface AnalyticsAudienceDimension {
  readonly dimensionName: string
}

export interface AnalyticsAudienceExport {
  readonly name?: string
  readonly audience: string
  readonly audienceDisplayName?: string
  readonly dimensions: readonly AnalyticsAudienceDimension[]
  readonly state?: "STATE_UNSPECIFIED" | "CREATING" | "ACTIVE" | "FAILED"
  readonly beginCreatingTime?: string
  readonly creationQuotaTokensCharged?: number
  readonly rowCount?: number
  readonly errorMessage?: string
  readonly percentageCompleted?: number
  readonly [key: string]: unknown
}

export interface AnalyticsOperation {
  readonly name?: string
  readonly done?: boolean
  readonly error?: AnalyticsOperationStatus
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly response?: Readonly<Record<string, unknown>>
}

export interface AnalyticsOperationStatus {
  readonly code?: number
  readonly message?: string
  readonly details?: readonly Readonly<Record<string, unknown>>[]
}

export type AnalyticsListAudienceExportsOptions = QueryParams & {
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface AnalyticsListAudienceExportsResponse {
  readonly audienceExports?: readonly AnalyticsAudienceExport[]
  readonly nextPageToken?: string
  readonly [key: string]: unknown
}

export interface AnalyticsQueryAudienceExportRequest {
  readonly offset?: string
  readonly limit?: string
}

export interface AnalyticsAudienceDimensionValue {
  readonly value?: string
}

export interface AnalyticsAudienceRow {
  readonly dimensionValues?: readonly AnalyticsAudienceDimensionValue[]
}

export interface AnalyticsQueryAudienceExportResponse {
  readonly audienceExport?: AnalyticsAudienceExport
  readonly audienceRows?: readonly AnalyticsAudienceRow[]
  readonly rowCount?: number
  readonly [key: string]: unknown
}

import type { QueryParams } from "./common"
