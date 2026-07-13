import type { ConnectorDefinition } from "../connectors/types"
import type { Logger } from "../logging"
import type { OntologySource, Sixb } from "../runtime"

export type WebhookBodyFormat = "json" | "text" | "raw"

/**
 * Runtime parser used by `.json(schema)`.
 *
 * The parser receives already-decoded JSON as `unknown` and must validate,
 * normalize, and return the body shape that handlers can safely use.
 */
export interface WebhookBodySchema<TBody> {
  parse(value: unknown): TBody
}

/** Internal body parser stored on the finalized webhook definition. */
export interface WebhookBodyParser<TBody> {
  readonly format: WebhookBodyFormat
  parse(value: unknown): TBody
}

/**
 * Connector-scoped inbound webhook definition.
 *
 * Definitions are inert metadata. The server owns route registration and
 * dispatch, while connector authors own verification, parsing, and handling.
 */
export interface WebhookDefinition<TBody = unknown, TClient = unknown> {
  readonly kind: "webhook"
  readonly id: string
  readonly method: "POST"
  readonly body: WebhookBodyParser<TBody>
  /** Stable provider delivery id used to skip duplicate or concurrent deliveries. */
  readonly idempotencyKey?: WebhookIdempotencyKeyResolver<TBody>
  /** Runs before body parsing and receives raw bytes for signature checks. */
  verify?(ctx: WebhookVerifyContext): Promise<void> | void
  handle(
    ctx: WebhookHandlerContext<TBody, TClient>
  ): Promise<WebhookHandlerResult> | WebhookHandlerResult
}

export interface WebhookMetadata {
  readonly id: string
  readonly method: "POST"
  readonly route: string
  readonly bodyFormat: WebhookBodyFormat
}

export interface WebhookVerifyContext {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  readonly connector: ConnectorDefinition
  readonly webhook: WebhookMetadata
  readonly request: Request
  readonly rawBody: Uint8Array
}

export interface WebhookHandlerContext<TBody, TClient> extends WebhookVerifyContext {
  readonly body: TBody
  /** Lazily resolve the connector client only when the handler needs it. */
  client(): Promise<TClient>
}

export interface WebhookIdempotencyContext<TBody> extends WebhookVerifyContext {
  readonly body: TBody
}

type BivariantCallback<TArgs extends readonly unknown[], TReturn> = {
  bivarianceHack(...args: TArgs): TReturn
}["bivarianceHack"]

export type WebhookIdempotencyKeyResolver<TBody> = BivariantCallback<
  [ctx: WebhookIdempotencyContext<TBody>],
  Promise<string | null | undefined> | string | null | undefined
>

/**
 * Optional handler response. When omitted, dispatch returns `202 Accepted`.
 */
export interface WebhookResponse {
  readonly status?: number
  readonly headers?: HeadersInit
  readonly body?: unknown
}

// biome-ignore lint/suspicious/noConfusingVoidType: webhook handlers intentionally support no-return callbacks.
export type WebhookHandlerResult = WebhookResponse | void

export interface RegisteredWebhook<
  TBody = unknown,
  TClient = unknown,
  TConnector extends ConnectorDefinition = ConnectorDefinition,
> {
  readonly connector: TConnector
  readonly webhook: WebhookDefinition<TBody, TClient>
  readonly route: string
}
