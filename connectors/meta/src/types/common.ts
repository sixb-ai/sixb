/** One page of a cursor-paginated Graph API edge. */
export interface MetaPage<T> {
  readonly items: readonly T[]
  /** True when the Graph API reported a `paging.next` link. */
  readonly hasMore: boolean
  /** The `paging.cursors.after` cursor — pass it back as `after` to fetch the next page. */
  readonly nextCursor?: string
}

/** Shared cursor-pagination inputs for list edges. */
export interface MetaPaginationOptions {
  /** Page size sent as `limit`. Defaults to 100. */
  readonly limit?: number
  /** Cursor from a previous page's `nextCursor`, sent as `after`. */
  readonly after?: string
}

/** A response header returned by Graph API, preserving Meta's batch representation. */
export interface MetaHeader {
  readonly name: string
  readonly value: string
}

/** The structured `error` object returned by Graph API. */
export interface MetaGraphError {
  readonly message: string
  readonly type?: string
  readonly code?: number
  readonly error_subcode?: number
  readonly is_transient?: boolean
  readonly error_user_title?: string
  readonly error_user_msg?: string
  readonly error_data?: unknown
  readonly fbtrace_id?: string
}

/** Percentage-based application usage from `X-App-Usage`. */
export interface MetaAppUsage {
  readonly call_count?: number
  readonly total_cputime?: number
  readonly total_time?: number
}

/** One business-use-case usage entry from `X-Business-Use-Case-Usage`. */
export interface MetaBusinessUseCaseUsageEntry extends MetaAppUsage {
  readonly type?: string
  /** Meta reports this duration in minutes. */
  readonly estimated_time_to_regain_access?: number
}

/** Business object id to its reported business-use-case usage entries. */
export type MetaBusinessUseCaseUsage = Readonly<
  Record<string, readonly MetaBusinessUseCaseUsageEntry[]>
>

/** Parsed quota metadata. Missing or malformed headers are omitted. */
export interface MetaUsage {
  readonly app?: MetaAppUsage
  readonly businessUseCase?: MetaBusinessUseCaseUsage
}

/** Metadata emitted for a Graph API response without changing resource return values. */
export interface MetaResponseMetadata {
  readonly path: string
  readonly method: "GET" | "POST"
  readonly status: number
  readonly headers: readonly MetaHeader[]
  readonly usage: MetaUsage
  /** Present when the response belongs to a sub-request inside a Graph batch. */
  readonly batchIndex?: number
}

/** Context supplied to a connector-level retry policy. */
export interface MetaRetryContext {
  readonly attempt: number
  readonly path: string
  readonly method: "GET" | "POST"
  readonly response: Response | null
  readonly error: unknown
  readonly graphError?: MetaGraphError
  readonly usage: MetaUsage
  readonly batchIndex?: number
}

export interface MetaRetryPolicy {
  readonly maxRetries?: number
  shouldRetry?(context: MetaRetryContext): boolean | Promise<boolean>
  delayMs?(context: MetaRetryContext): number | Promise<number>
}

/**
 * A measured Graph API metric, returned by an `/insights` edge.
 *
 * Returned faithfully: `values` carries time-series points, `total_value` carries
 * the aggregate for `metric_type=total_value` metrics. Callers decide which to read.
 */
export interface MetaInsight {
  readonly name: string
  readonly period?: string
  readonly title?: string
  readonly description?: string
  readonly values?: readonly MetaInsightValue[]
  readonly total_value?: unknown
  readonly id?: string
}

export interface MetaInsightValue {
  readonly value?: unknown
  readonly end_time?: string
}

/**
 * Query for an `/insights` edge.
 *
 * The connector stays metric-agnostic: it passes `metrics`, `period`, `metricType`,
 * `since`, `until`, and `breakdown` straight through. Meta requires some metrics to be
 * requested with `metric_type=total_value` and forbids mixing incompatible metrics in one
 * call — that partitioning is the caller's responsibility, not the connector's.
 */
export interface InsightsQuery {
  readonly metrics: readonly string[]
  /** e.g. "day", "week", "days_28", "lifetime", "total_over_range". */
  readonly period?: string
  /** Omit to use the API default (time series). */
  readonly metricType?: "total_value" | "time_series"
  /** Lower bound, serialized to Unix seconds. */
  readonly since?: Date
  /** Upper bound, serialized to Unix seconds. */
  readonly until?: Date
  /** Breakdown dimensions, sent as a comma-separated `breakdown` param. */
  readonly breakdown?: readonly string[]
}
