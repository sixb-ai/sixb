import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { GoogleAuthOptions } from "../auth"

/** A major Google Ads REST endpoint version, for example `v25`. */
export type GoogleAdsApiVersion = `v${number}`

export interface GoogleAdsConnectorOptions {
  readonly auth: GoogleAuthOptions
  /** Developer token from the Google Ads API Center. Sent on every request. */
  readonly developerToken: string
  /** Manager account used as `login-customer-id`. Hyphenated UI values are accepted. */
  readonly loginCustomerId: string
  /** Major REST endpoint version. Defaults to the current `v25` endpoint. */
  readonly apiVersion?: GoogleAdsApiVersion
  /** Host override for tests/proxies. Defaults to `https://googleads.googleapis.com/`. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
}

export type GoogleAdsCustomerStatus =
  | "UNSPECIFIED"
  | "UNKNOWN"
  | "ENABLED"
  | "CANCELED"
  | "SUSPENDED"
  | "CLOSED"

/** The `customer_client` resource selected from a manager account. */
export interface GoogleAdsCustomerClient {
  readonly resourceName?: string
  /** Resource name of the client, for example `customers/1234567890`. */
  readonly clientCustomer?: string
  /** int64 JSON value; deliberately kept as a string. */
  readonly id?: string
  readonly descriptiveName?: string
  readonly currencyCode?: string
  readonly timeZone?: string
  readonly manager?: boolean
  /** int64 JSON value; deliberately kept as a string. */
  readonly level?: string
  readonly status?: GoogleAdsCustomerStatus
  readonly testAccount?: boolean
  readonly hidden?: boolean
  readonly [field: string]: unknown
}

/** Enabled, non-manager descendant returned by `customers.listManaged()`. */
export interface GoogleAdsManagedCustomer extends GoogleAdsCustomerClient {
  readonly id: string
  readonly manager: false
  readonly status: "ENABLED"
}

export interface GoogleAdsCustomer {
  readonly resourceName?: string
  /** int64 JSON value; deliberately kept as a string. */
  readonly id?: string
  readonly descriptiveName?: string
  readonly currencyCode?: string
  readonly timeZone?: string
  readonly manager?: boolean
  readonly testAccount?: boolean
  readonly [field: string]: unknown
}

export interface GoogleAdsCampaign {
  readonly resourceName?: string
  /** int64 JSON value; deliberately kept as a string. */
  readonly id?: string
  readonly name?: string
  readonly status?: string
  readonly advertisingChannelType?: string
  readonly advertisingChannelSubType?: string
  readonly [field: string]: unknown
}

export interface GoogleAdsSegments {
  readonly date?: string
  readonly device?: string
  readonly adNetworkType?: string
  readonly [field: string]: unknown
}

/** Common additive reporting metrics. int64 and micros values remain strings. */
export interface GoogleAdsMetrics {
  readonly impressions?: string
  readonly clicks?: string
  readonly interactions?: string
  readonly costMicros?: string
  readonly conversions?: number
  readonly conversionsValue?: number
  readonly allConversions?: number
  readonly allConversionsValue?: number
  readonly viewThroughConversions?: string
  readonly [field: string]: unknown
}

/** Open GoogleAdsRow shape. Supply a query-specific generic to `reports.search*` if desired. */
export interface GoogleAdsRow {
  readonly customer?: GoogleAdsCustomer
  readonly customerClient?: GoogleAdsCustomerClient
  readonly campaign?: GoogleAdsCampaign
  readonly segments?: GoogleAdsSegments
  readonly metrics?: GoogleAdsMetrics
  readonly [resource: string]: unknown
}

export interface GoogleAdsSearchSettings {
  readonly omitResults?: boolean
  readonly returnSummaryRow?: boolean
  readonly returnTotalResultsCount?: boolean
}

export interface GoogleAdsSearchRequest {
  readonly query: string
  readonly pageToken?: string
  readonly validateOnly?: boolean
  readonly searchSettings?: GoogleAdsSearchSettings
}

export type GoogleAdsSummaryRowSetting =
  | "UNSPECIFIED"
  | "UNKNOWN"
  | "NO_SUMMARY_ROW"
  | "SUMMARY_ROW_WITH_RESULTS"
  | "SUMMARY_ROW_ONLY"

export interface GoogleAdsSearchStreamRequest {
  readonly query: string
  readonly summaryRowSetting?: GoogleAdsSummaryRowSetting
}

export interface GoogleAdsMetricAttribute {
  readonly [field: string]: unknown
}

export interface GoogleAdsSearchResponse<TRow = GoogleAdsRow> {
  readonly results?: readonly TRow[]
  readonly nextPageToken?: string
  /** int64 JSON value; deliberately kept as a string. */
  readonly totalResultsCount?: string
  readonly fieldMask?: string
  readonly summaryRow?: TRow
  /** int64 JSON value; deliberately kept as a string. */
  readonly queryResourceConsumption?: string
  readonly metricAttributes?: readonly GoogleAdsMetricAttribute[]
}

export interface GoogleAdsSearchStreamResponse<TRow = GoogleAdsRow> {
  readonly results?: readonly TRow[]
  readonly fieldMask?: string
  readonly summaryRow?: TRow
  readonly requestId?: string
  /** int64 JSON value; deliberately kept as a string. */
  readonly queryResourceConsumption?: string
  readonly metricAttributes?: readonly GoogleAdsMetricAttribute[]
}

export interface GoogleAdsCustomerDailyPerformanceOptions {
  /** Inclusive advertiser-local date in `YYYY-MM-DD` format. */
  readonly startDate: string
  /** Inclusive advertiser-local date in `YYYY-MM-DD` format. */
  readonly endDate: string
}

/** One `(customer, segments.date)` row from the built-in daily performance report. */
export interface GoogleAdsCustomerDailyPerformanceRow extends GoogleAdsRow {
  readonly customer: GoogleAdsCustomer
  readonly segments: GoogleAdsSegments & { readonly date: string }
  readonly metrics: GoogleAdsMetrics
}

export interface GoogleAdsErrorLocation {
  readonly fieldPathElements?: readonly {
    readonly fieldName?: string
    readonly index?: number
  }[]
  readonly [field: string]: unknown
}

export interface GoogleAdsErrorDetail {
  readonly errorCode?: Readonly<Record<string, string>>
  readonly message?: string
  readonly trigger?: Readonly<Record<string, unknown>>
  readonly location?: GoogleAdsErrorLocation
  readonly details?: Readonly<Record<string, unknown>>
  readonly [field: string]: unknown
}

export interface GoogleAdsFailure {
  readonly "@type"?: string
  readonly errors?: readonly GoogleAdsErrorDetail[]
  readonly requestId?: string
  readonly [field: string]: unknown
}
