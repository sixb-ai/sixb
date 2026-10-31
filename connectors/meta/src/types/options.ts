import type { MetaResponseMetadata, MetaRetryPolicy } from "./common"

/** Transport options shared by the system-token and OAuth connectors. */
export interface MetaTransportOptions {
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

export interface MetaConnectorOptions extends MetaTransportOptions {
  /** Long-lived User or System-User access token. Required. */
  readonly accessToken: string
  readonly appId?: never
}

interface MetaOAuthBaseOptions extends MetaTransportOptions {
  /** Meta app ID. */
  readonly appId: string
  /** Meta app secret. Used server-side only, for the code and token exchanges. */
  readonly appSecret: string
  readonly accessToken?: never
}

/**
 * Sign in with Facebook and connect the Pages the user grants. Pass `configId` for Facebook Login
 * for Business (Business apps) or `scopes` for Facebook Login.
 */
export type MetaOAuthConnectorOptions = MetaOAuthBaseOptions &
  (
    | {
        /** Facebook Login for Business configuration, of the "User access token" type. */
        readonly configId: string
        readonly scopes?: never
      }
    | {
        /** Facebook Login permissions, e.g. `pages_show_list` and `pages_manage_posts`. */
        readonly scopes: readonly string[]
        readonly configId?: never
      }
  )
