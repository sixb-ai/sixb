import type { WebhookDefinition } from "../webhooks/types"

/**
 * Runtime context passed to connector adapters when Sixb establishes a connection.
 *
 * Connectors can use this to scope logs, build cache keys, or attach cancellation
 * to long-running startup work.
 */
export interface ConnectorContext {
  readonly projectId: string
  readonly connectorId: string
  readonly signal: AbortSignal
}

/**
 * Minimal contract for a Sixb connector adapter.
 *
 * Adapters are responsible for creating and optionally tearing down a client for an
 * external system. They should return the client shape that feels natural for that system.
 */
export interface ConnectorAdapter<TType extends string = string, TClient = unknown> {
  readonly type: TType
  readonly webhooks?: readonly WebhookDefinition<unknown, TClient>[]
  connect(context: ConnectorContext): Promise<TClient> | TClient
  disconnect?(client: TClient): Promise<void> | void
}

/**
 * Inert connector definition registered with Sixb.
 *
 * Definitions are safe to export from `connectors/` modules. The runtime turns them into
 * live clients when `sixb.connector(...)` is called.
 */
export interface ConnectorDefinition<
  TId extends string = string,
  TAdapter extends ConnectorAdapter = ConnectorAdapter,
> {
  readonly kind: "connector"
  readonly id: TId
  readonly adapter: TAdapter
}

/** Infer the connected client type returned by a connector adapter. */
export type ConnectorClient<TAdapter extends ConnectorAdapter> = Awaited<
  ReturnType<TAdapter["connect"]>
>

export function isConnectorDefinition(value: unknown): value is ConnectorDefinition {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === "connector" &&
    typeof value.id === "string" &&
    isRecord(value.adapter) &&
    typeof value.adapter.type === "string" &&
    typeof value.adapter.connect === "function"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
