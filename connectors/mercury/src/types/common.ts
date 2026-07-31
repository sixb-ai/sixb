import type { WebhookDefinition } from "@sixb/core"
import type { MercuryClient } from "./client"
import type { MercuryEventHandler } from "./events"

export type MercuryAccessTokenResolver = string | (() => string | Promise<string>)

export type MercuryRequestMethod = "GET" | "POST" | "PATCH" | "DELETE"

export interface MercuryRetryContext {
  readonly attempt: number
  readonly method: MercuryRequestMethod
  readonly response: Response | null
  readonly error: unknown
}

export interface MercuryRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: MercuryRetryContext): boolean
  delayMs?(context: MercuryRetryContext): number
}

export interface MercuryConnectorOptions {
  /**
   * Mercury API token or OAuth access-token resolver, sent as Bearer auth. Mercury tokens carry
   * their own `secret-token:` prefix — pass the token exactly as the dashboard shows it.
   */
  readonly accessToken: MercuryAccessTokenResolver
  /**
   * API base URL. Defaults to https://api.mercury.com/api/v1/. Point this at
   * https://api-sandbox.mercury.com/api/v1/ to run against the sandbox.
   */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Minimum delay between request starts. Mercury documents no rate limit, so it defaults to 0. */
  readonly minDelayMs?: number
  /** Method-aware retry policy. By default, only transient GET failures are retried. */
  readonly retry?: MercuryRetryPolicy
  /**
   * Handler for inbound webhook deliveries. Providing it registers the connector's `events`
   * webhook route; omit it and the connector exposes no inbound HTTP surface.
   */
  readonly onEvent?: MercuryEventHandler
  /**
   * Signing secret for inbound webhook verification, returned as `secret` when the endpoint is
   * created. Deliveries are rejected unless this verifies against `Mercury-Signature`.
   */
  readonly webhookSecret?: string
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookSecret` the route accepts unsigned requests from anyone who can
   * reach it, so the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnsigned?: boolean
  /** Maximum accepted age of a webhook signature timestamp. Defaults to 5 minutes. */
  readonly webhookToleranceMs?: number
  /** Extra inbound webhooks to register alongside the built-in `events` route. */
  readonly webhooks?: readonly WebhookDefinition<unknown, MercuryClient>[]
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

/** Sort direction shared by every Mercury list endpoint. Defaults to `asc` upstream. */
export type MercuryOrder = "asc" | "desc"

/**
 * Cursor pagination options shared by every cursor-paginated Mercury endpoint. Cursors are
 * resource ids, not opaque tokens. `start_after` and `end_before` are mutually exclusive.
 */
export interface MercuryCursorOptions {
  /** Results per page, 1 to 1000. Defaults to 1000 upstream. */
  readonly limit?: number
  readonly order?: MercuryOrder
  /** Start the page after this id (exclusive) — forward pagination. */
  readonly start_after?: string
  /** End the page before this id (exclusive) — reverse pagination. */
  readonly end_before?: string
}

/**
 * Cursors returned alongside every cursor-paginated collection. Both are absent on the last
 * page in their direction, which is how `listAll*` knows to stop.
 */
export interface MercuryPageCursors {
  readonly nextPage?: string
  readonly previousPage?: string
}

/** Envelope shape shared by every cursor-paginated Mercury response. */
export interface MercuryCursorPage {
  readonly page: MercuryPageCursors
}

/** ISO 8601 UTC timestamp, e.g. `2016-07-22T00:00:00Z`. */
export type MercuryTimestamp = string

/** Calendar date with no time component, e.g. `2016-07-22`. */
export type MercuryDay = string

/** ISO 4217 currency code. */
export type MercuryCurrencyCode = string

/** ISO 3166-1 alpha-2 country code. */
export type MercuryCountryCode = string

export type MercuryUsState =
  | "AL"
  | "AK"
  | "AZ"
  | "AR"
  | "CA"
  | "CO"
  | "CT"
  | "DE"
  | "DC"
  | "FL"
  | "GA"
  | "HI"
  | "ID"
  | "IL"
  | "IN"
  | "IA"
  | "KS"
  | "KY"
  | "LA"
  | "ME"
  | "MD"
  | "MA"
  | "MI"
  | "MN"
  | "MS"
  | "MO"
  | "MT"
  | "NE"
  | "NV"
  | "NH"
  | "NJ"
  | "NM"
  | "NY"
  | "NC"
  | "ND"
  | "OH"
  | "OK"
  | "OR"
  | "PA"
  | "RI"
  | "SC"
  | "SD"
  | "TN"
  | "TX"
  | "UT"
  | "VT"
  | "VA"
  | "WA"
  | "WV"
  | "WI"
  | "WY"

/** Postal address as returned on transaction method details. */
export interface MercuryAddressData {
  readonly address1: string
  readonly address2?: string | null
  readonly city: string
  readonly postalCode: string
  readonly state?: MercuryUsState | null
}

/** Postal address as returned on wire routing details and AR customers. */
export interface MercuryAddress {
  readonly address1: string
  readonly address2?: string | null
  readonly city: string
  /** State, province, or region. */
  readonly region: string
  readonly postalCode: string
  readonly country: MercuryCountryCode
}
