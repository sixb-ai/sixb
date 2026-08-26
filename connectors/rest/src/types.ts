import type { ConnectorAdapter, ConnectorContext, WebhookDefinition } from "@sixb/core"

export interface RestRequestContext {
  readonly projectId: ConnectorContext["projectId"]
  readonly connectorId: ConnectorContext["connectorId"]
  readonly path: string
  readonly init: RequestInit
  readonly method: string
  /** Whether replaying this request is safe from an API-semantics perspective. */
  readonly idempotent: boolean
  /** Whether the serialized request body can mechanically be sent more than once. */
  readonly bodyReplayable: boolean
}

export type RestHeadersResolver =
  | HeadersInit
  | ((context: RestRequestContext) => HeadersInit | Promise<HeadersInit>)

export interface RestRetryContext extends RestRequestContext {
  readonly attempt: number
  readonly response: Response | null
  readonly error: unknown
}

export interface RestRetryPolicy {
  readonly maxRetries?: number
  shouldRetry?(context: RestRetryContext): boolean | Promise<boolean>
  delayMs?(context: RestRetryContext): number | Promise<number>
}

export interface RestConnectorOptions {
  readonly baseUrl: string
  readonly headers?: RestHeadersResolver
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly onUnauthorized?: (context: RestRequestContext) => Promise<void> | void
  readonly retry?: RestRetryPolicy
  readonly webhooks?: readonly WebhookDefinition<unknown, RestClient>[]
}

export interface RestRequestOptions {
  /** Override the method-derived idempotency used by the default retry policy. */
  readonly idempotent?: boolean
  /** Hard retry gate. False prevents custom policies and 401 refreshes from replaying the request. */
  readonly retryable?: boolean
}

export type RestRequestInit = Omit<RequestInit, "body"> & {
  readonly body?: unknown
  /** @deprecated Pass `retryable` through RestRequestOptions instead. */
  readonly retry?: boolean
}

export type RestQueryScalar = string | number | boolean
export type RestQueryValue = RestQueryScalar | readonly RestQueryScalar[] | null | undefined
export type RestQueryParams = Readonly<Record<string, RestQueryValue>>

export interface RestQueryOptions {
  /** How array values are represented. Defaults to repeated query parameters. */
  readonly arrayFormat?: "repeat" | "comma"
  /** Whether empty string values are omitted. Defaults to false. */
  readonly omitEmptyString?: boolean
}

export interface RestClient {
  request(path: string, init?: RestRequestInit, options?: RestRequestOptions): Promise<Response>
  get(path: string, init?: RestRequestInit, options?: RestRequestOptions): Promise<Response>
  post(
    path: string,
    body?: unknown,
    init?: RestRequestInit,
    options?: RestRequestOptions
  ): Promise<Response>
}

export type RestConnector = ConnectorAdapter<"rest", RestClient>
