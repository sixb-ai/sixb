export type AceIotApiKeyResolver = string | (() => string | Promise<string>)

export type AceIotRequestMethod = "GET" | "POST" | "PUT" | "PATCH"

export interface AceIotRetryContext {
  readonly attempt: number
  readonly method: AceIotRequestMethod
  /** True when replaying the request cannot change server state, so a retry is safe. */
  readonly idempotent: boolean
  readonly response: Response | null
  readonly error: unknown
}

export interface AceIotRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: AceIotRetryContext): boolean
  delayMs?(context: AceIotRetryContext): number
}

export interface AceIotConnectorOptions {
  /** ACE API key, or a resolver called before every attempt. Sent as `Authorization: Bearer`. */
  readonly apiKey: AceIotApiKeyResolver
  /** API base URL. Defaults to https://flightdeck.aceiot.cloud/api/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Minimum delay between request starts. Defaults to 0 — ACE publishes no rate limit. */
  readonly minDelayMs?: number
  /** Method-aware retry policy. By default, only reads are retried. */
  readonly retry?: AceIotRetryPolicy
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

/**
 * An ISO 8601 timestamp with no zone designator, as ACE returns it: `2026-08-07T16:25:00`, or
 * `2026-08-07T16:25:00.627593` when microseconds are present. The instant is UTC, but because the
 * string does not say so, `new Date(value)` reads it as local time. Use `parseAceIotTimestamp`.
 */
export type AceIotTimestamp = string

/** A `Date`, or any string the ACE API accepts for `start_time`/`end_time`. */
export type AceIotTimeInput = Date | string

/**
 * Page sizes the ACE API accepts for `per_page`. It is a closed enum, not a range: any other value
 * is rejected with a 400, so the connector checks it before spending a request.
 */
export const ACE_IOT_PER_PAGE_VALUES = [
  2, 10, 20, 30, 40, 50, 100, 500, 1000, 5000, 10000, 100000,
] as const

export type AceIotPerPage = (typeof ACE_IOT_PER_PAGE_VALUES)[number]

export interface AceIotPageOptions {
  /** 1-based page number. Defaults to 1. */
  readonly page?: number
  readonly perPage?: AceIotPerPage
}

export interface AceIotListAllOptions extends AceIotPageOptions {
  /** Stop after this many pages. Unbounded by default. */
  readonly maxPages?: number
}

/**
 * ACE's page envelope. `pages` is `null` on some endpoints (the gateway PCAP listing returns
 * `{"items": [], "page": 1, "pages": null, "total": 0}`), so it cannot be the sole stop condition.
 */
export interface AceIotPage<TItem> {
  readonly items: readonly TItem[]
  readonly page: number
  readonly pages: number | null
  readonly per_page: number
  readonly total: number
}
