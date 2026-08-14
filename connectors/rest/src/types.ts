import type { ConnectorAdapter, ConnectorContext, WebhookDefinition } from "@sixb/core"

export interface RestRequestContext {
  readonly projectId: ConnectorContext["projectId"]
  readonly connectorId: ConnectorContext["connectorId"]
  readonly path: string
  readonly init: RequestInit
}

export type RestHeadersResolver =
  | HeadersInit
  | ((context: RestRequestContext) => HeadersInit | Promise<HeadersInit>)

export interface RestRetryContext {
  readonly attempt: number
  readonly response: Response | null
  readonly error: unknown
}

export interface RestRetryPolicy {
  readonly maxRetries?: number
  shouldRetry?(context: RestRetryContext): boolean
  delayMs?(context: RestRetryContext): number
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

/** Native fetch options plus a local retry gate that is never sent over the wire. */
export interface RestRequestInit extends RequestInit {
  readonly retry?: boolean
}

export interface RestClient {
  request(path: string, init?: RestRequestInit): Promise<Response>
  get(path: string, init?: RestRequestInit): Promise<Response>
  post(path: string, body?: unknown, init?: RestRequestInit): Promise<Response>
}

export type RestConnector = ConnectorAdapter<"rest", RestClient>
