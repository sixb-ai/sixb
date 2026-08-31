import type { MetaResponseMetadata, MetaRetryPolicy } from "./common"

export interface MetaConnectorOptions {
  /** Long-lived User or System-User access token. Required. */
  readonly accessToken: string
  /** Graph API version segment, e.g. "v23.0". Defaults to the connector's pinned version. */
  readonly graphVersion?: string
  /** Full base URL override (takes precedence over `graphVersion`). Mainly for tests. */
  readonly baseUrl?: string
  /** @deprecated Prefer `retry.maxRetries`. */
  readonly maxRetries?: number
  /** Retry policy for transient HTTP failures and Meta throttling errors. */
  readonly retry?: MetaRetryPolicy
  /** Observe response headers and parsed quota usage without wrapping resource return values. */
  readonly onResponse?: (metadata: MetaResponseMetadata) => Promise<void> | void
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
}
