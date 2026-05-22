import {
  type ConnectorAdapter,
  type ConnectorClient,
  type ConnectorDefinition,
  isConnectorDefinition,
} from "../connectors"
import type { DatasetDefinition } from "../datasets"
import { isDatasetDefinition } from "../datasets"
import type { ScheduleDefinition } from "../schedules"
import type { RunTrigger } from "../triggers"
import { isRunTrigger } from "../triggers"

/**
 * Context passed to a sync read handler.
 *
 * V1 keeps this intentionally small and connector-focused. It does not expose
 * the Pario runtime, worker state, or checkpoint information.
 */
export interface SyncReadContext {
  readonly projectId: string
  readonly syncId: string
  readonly signal: AbortSignal
}

/** A sync read handler may return one item, a sync iterable, or an async iterable. */
export type SyncReadResult = unknown | Iterable<unknown> | AsyncIterable<unknown>

/** User-facing batch sync options accepted by `defineSync(...)`. */
export interface BatchSyncConfig {
  readonly mode?: "snapshot" | "append"
}

/** Normalized batch sync config stored on the final sync definition. */
export interface BatchSyncDefinitionConfig {
  readonly kind: "batch"
  readonly mode: "snapshot" | "append"
}

/** V1 syncs always target a named raw dataset. */
export interface DatasetSyncTarget {
  readonly kind: "dataset"
  readonly dataset: DatasetDefinition
}

/** Connector-scoped read handler used by batch sync definitions. */
export type SyncReadHandler<TAdapter extends ConnectorAdapter> = (
  client: ConnectorClient<TAdapter>,
  context: SyncReadContext
) => SyncReadResult | Promise<SyncReadResult>

/**
 * Inert sync definition registered with Pario.
 *
 * V1 supports batch syncs only. Definitions are declarative metadata and do not
 * start any background work on their own.
 */
export interface SyncDefinition<
  TId extends string = string,
  TConnector extends ConnectorDefinition = ConnectorDefinition,
> {
  readonly kind: "sync"
  readonly id: TId
  readonly config: BatchSyncDefinitionConfig
  readonly triggers: readonly RunTrigger[]
  readonly connector: TConnector
  readonly read: SyncReadHandler<TConnector["adapter"]>
  readonly target: DatasetSyncTarget
}

export interface SyncTargetBuilder<
  TId extends string = string,
  TConnector extends ConnectorDefinition = ConnectorDefinition,
> {
  intoDataset(dataset: DatasetDefinition): SyncDefinition<TId, TConnector>
}

export interface SyncReadBuilder<
  TId extends string = string,
  TConnector extends ConnectorDefinition = ConnectorDefinition,
> {
  read(handler: SyncReadHandler<TConnector["adapter"]>): SyncTargetBuilder<TId, TConnector>
}

export interface SyncBuilder<TId extends string = string> {
  when(trigger: ScheduleDefinition | RunTrigger): SyncBuilder<TId>
  from<TConnector extends ConnectorDefinition>(
    connector: TConnector
  ): SyncReadBuilder<TId, TConnector>
}

/** Runtime type guard for values discovered from `syncs/` modules. */
export function isSyncDefinition(value: unknown): value is SyncDefinition {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === "sync" &&
    typeof value.id === "string" &&
    isRecord(value.config) &&
    value.config.kind === "batch" &&
    (value.config.mode === "snapshot" || value.config.mode === "append") &&
    Array.isArray(value.triggers) &&
    (value.triggers as unknown[]).every((t) => isRunTrigger(t)) &&
    isConnectorDefinition(value.connector) &&
    typeof value.read === "function" &&
    isRecord(value.target) &&
    value.target.kind === "dataset" &&
    isDatasetDefinition(value.target.dataset)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
