export interface MetaConnectorOptions {
  /** Long-lived User or System-User access token. Required. */
  readonly accessToken: string
  /** Graph API version segment, e.g. "v23.0". Defaults to the connector's pinned version. */
  readonly graphVersion?: string
  /** Full base URL override (takes precedence over `graphVersion`). Mainly for tests. */
  readonly baseUrl?: string
  /** Max retries on 429/5xx responses. Defaults to 2. */
  readonly maxRetries?: number
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
}
