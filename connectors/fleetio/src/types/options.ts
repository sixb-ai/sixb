import type { FleetioEventHandler } from "./events"

export type FleetioCredentialResolver = string | (() => string | Promise<string>)

export type FleetioRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface FleetioRetryContext {
  readonly attempt: number
  readonly method: FleetioRequestMethod
  /** Whether the request is a read, so replaying it cannot change anything. */
  readonly idempotent: boolean
  readonly response: Response | null
  readonly error: unknown
}

export interface FleetioRetryPolicy {
  /** Number of retries after the initial request. Defaults to 2. */
  readonly maxRetries?: number
  shouldRetry?(context: FleetioRetryContext): boolean
  delayMs?(context: FleetioRetryContext): number
}

export interface FleetioConnectorOptions {
  /** API key from https://secure.fleetio.com/api_keys, sent as `Authorization: Token <key>`. */
  readonly apiKey: FleetioCredentialResolver
  /** Account token from the same page, sent as `Account-Token`. */
  readonly accountToken: FleetioCredentialResolver
  /** API base URL. Defaults to https://secure.fleetio.com/api/. */
  readonly baseUrl?: string
  /**
   * API version sent as `X-Api-Version` on every request, overriding the version the key is
   * locked to. Defaults to `2025-05-05`, the version this connector's types describe.
   */
  readonly apiVersion?: string
  readonly timeoutMs?: number
  /** Minimum delay between request starts. Fleetio's limits depend on the plan, so it defaults to 0. */
  readonly minDelayMs?: number
  /** Retry policy. By default reads retry transient failures and writes retry only a 429. */
  readonly retry?: FleetioRetryPolicy
  /**
   * Handler for inbound webhook deliveries. Providing it registers the connector's `events`
   * webhook route; omit it and the connector exposes no inbound HTTP surface.
   */
  readonly onEvent?: FleetioEventHandler
  /** The webhook's secret, from "View Secret" in Fleetio or `shared_key` on the API response. */
  readonly webhookSecret?: string
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookSecret` the route accepts unverified requests from anyone who can
   * reach it, so the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnverified?: boolean
}
