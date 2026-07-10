export type PennylaneAccessTokenResolver = string | (() => string | Promise<string>)

export type PennylaneRequestMethod = "GET" | "POST" | "PUT"

export interface PennylaneRetryContext {
  readonly attempt: number
  readonly method: PennylaneRequestMethod
  readonly response: Response | null
  readonly error: unknown
}

export interface PennylaneRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: PennylaneRetryContext): boolean
  delayMs?(context: PennylaneRetryContext): number
}

export interface PennylaneConnectorOptions {
  /** Company API token or OAuth access-token resolver. */
  readonly accessToken: PennylaneAccessTokenResolver
  /** API base URL. Defaults to https://app.pennylane.com/api/external/v2/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Minimum delay between requests. Defaults to 200ms (25 requests per 5 seconds). */
  readonly minDelayMs?: number
  /** Method-aware retry policy. By default, only transient GET failures are retried. */
  readonly retry?: PennylaneRetryPolicy
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

export interface PennylaneCursorOptions {
  readonly cursor?: string
  readonly limit?: number
}

export interface PennylaneCursorPage<TItem> {
  readonly has_more: boolean
  readonly next_cursor: string | null
  readonly items: readonly TItem[]
}

export type PennylaneIdSort = "id" | "-id"

export type PennylaneLanguage = "fr_FR" | "en_GB" | "de_DE"

export type PennylaneQuoteStatus = "pending" | "accepted" | "denied" | "invoiced" | "expired"

export type PennylaneDiscountType = "absolute" | "relative"

export interface PennylaneDiscount {
  readonly type: PennylaneDiscountType
  /** Decimal amount or percentage, as represented by Pennylane. */
  readonly value: string
}

/** ISO 4217 currency code. Pennylane may add supported currencies without notice. */
export type PennylaneCurrency = string

/** Pennylane VAT code, including country-specific, exemption, and mixed-rate codes. */
export type PennylaneVatRate = string
