import type { CtmId } from "./common"
import type { CtmEventHandler, CtmWebhookBasicAuth } from "./webhooks"

export type CtmCredentialResolver = string | (() => string | Promise<string>)

export type CtmRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface CtmRetryContext {
  readonly attempt: number
  readonly method: CtmRequestMethod
  /** Whether the request is a read, so replaying it cannot change anything. */
  readonly idempotent: boolean
  readonly response: Response | null
  readonly error: unknown
}

export interface CtmRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: CtmRetryContext): boolean
  delayMs?(context: CtmRetryContext): number
}

export interface CtmConnectorOptions {
  /** The API access key, from Account Settings (one account) or Agency Settings (all of them). */
  readonly accessKey: CtmCredentialResolver
  /** The API secret key shown with it. */
  readonly secretKey: CtmCredentialResolver
  /**
   * The account the client's resources address. An agency key reaches its other accounts with
   * `client.account(id)`.
   */
  readonly accountId?: CtmId
  /** API base URL. Defaults to https://api.calltrackingmetrics.com/api/v1/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Minimum delay between request starts. Defaults to 100 ms: CTM allows 10 requests a second. */
  readonly minDelayMs?: number
  /** Retry policy. By default reads retry transient failures and writes retry only a 429. */
  readonly retry?: CtmRetryPolicy
  /**
   * Handler for inbound webhook deliveries. Providing it registers the connector's `events`
   * webhook route; omit it and the connector exposes no inbound HTTP surface.
   */
  readonly onEvent?: CtmEventHandler
  /** The username and password set on the webhook in CTM, which it sends as basic auth. */
  readonly webhookAuth?: CtmWebhookBasicAuth
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookAuth` the route accepts unverified requests from anyone who can reach it, so
   * the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnverified?: boolean
}
