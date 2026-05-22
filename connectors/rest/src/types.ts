import type { ConnectorAdapter, ConnectorContext, WebhookDefinition } from "@pario/core"

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

export interface RestClient {
  request(path: string, init?: RequestInit): Promise<Response>
  get(path: string, init?: RequestInit): Promise<Response>
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>
}

export type RestConnector = ConnectorAdapter<"rest", RestClient>
