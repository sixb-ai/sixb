import type { UnipileEventHandler } from "./webhooks"

export type UnipileAccessTokenResolver = string | (() => string | Promise<string>)

export type UnipileRequestMethod = "GET" | "POST" | "DELETE"

export interface UnipileRetryContext {
  readonly attempt: number
  readonly method: UnipileRequestMethod
  readonly path: string
  readonly response: Response | null
  readonly error: unknown
}

export interface UnipileRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2 for explicitly safe reads. */
  readonly maxRetries?: number
  shouldRetry?(context: UnipileRetryContext): boolean
  delayMs?(context: UnipileRetryContext): number
}

export interface UnipileConnectorOptions {
  /** Account-specific Unipile DSN, for example `https://api123.unipile.com:13337`. */
  readonly dsn: string
  /** Access token or async resolver, sent in `X-API-KEY` on every attempt. */
  readonly accessToken: UnipileAccessTokenResolver
  readonly timeoutMs?: number
  /** Global minimum delay between request starts. Campaign scheduling remains the caller's job. */
  readonly minDelayMs?: number
  /** Retry policy used only by synchronized Unipile reads; writes and LinkedIn actions never retry. */
  readonly retry?: UnipileRetryPolicy
  /** Shared value expected in `X-Sixb-Unipile-Secret` on inbound deliveries. */
  readonly webhookSecret?: string
  /** Explicitly expose an unverified inbound route. Intended only for local development. */
  readonly webhookAllowUnverified?: boolean
  /** Handler for message, account-status, and new-relation webhook deliveries. */
  readonly onEvent?: UnipileEventHandler
}

export type UnipileTimestamp = string
export type UnipileBoolean = boolean | 0 | 1

export type UnipileMessagingProvider =
  | "LINKEDIN"
  | "WHATSAPP"
  | "INSTAGRAM"
  | "MESSENGER"
  | "TELEGRAM"
  | "TWITTER"
  | (string & {})

export interface UnipileCursorOptions {
  /** Results per page. Most v1 collections accept 1 to 250. */
  readonly limit?: number
  readonly cursor?: string
}

export interface UnipileCursorPage<T> {
  readonly object: string
  readonly items: readonly T[]
  readonly cursor: string | null
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>
