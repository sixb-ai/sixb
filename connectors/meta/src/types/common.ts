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
