import type { BlobStorage } from "../blob-storage"
import {
  type ConnectorAdapter,
  type ConnectorClient,
  type ConnectorDefinition,
  isConnectorDefinition,
} from "../connectors"
import type { DatasetDefinition, DatasetPrimaryKey, MergeChange } from "../datasets"
import { isDatasetDefinition } from "../datasets"
import type { Logger } from "../logging"
import type { ScheduleDefinition, ScheduleReference } from "../schedules"
import { isScheduleReference } from "../schedules"

/** Blob operations available to sync read handlers. */
export type SyncBlobContext = Pick<BlobStorage, "put" | "open" | "stat">

/** Context passed to a sync read handler. */
export type SyncReadContext<TCheckpoint = never> = {
  readonly projectId: string
  readonly syncId: string
  readonly signal: AbortSignal
  readonly blobs: SyncBlobContext
  readonly logger: Logger
} & ([TCheckpoint] extends [never]
  ? { readonly checkpoint?: undefined }
  : {
      readonly checkpoint?: TCheckpoint
      setCheckpoint(next: TCheckpoint): void
    })

export type SyncMode = "snapshot" | "append" | "merge"

type MergeSyncChange = MergeChange<
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>
>

/** A sync read handler may return one item, a sync iterable, or an async iterable. */
export type SyncReadResult<TMode extends SyncMode = SyncMode> = TMode extends "merge"
  ? MergeSyncChange | Iterable<MergeSyncChange> | AsyncIterable<MergeSyncChange>
  : unknown | Iterable<unknown> | AsyncIterable<unknown>

/** User-facing batch sync options accepted by `defineSync(...)`. */
export interface BatchSyncConfig<TMode extends SyncMode = SyncMode> {
  readonly mode?: TMode
}

/** Normalized batch sync config stored on the final sync definition. */
export interface BatchSyncDefinitionConfig<TMode extends SyncMode = SyncMode> {
  readonly kind: "batch"
  readonly mode: TMode
}

/** V1 syncs always target a named raw dataset. */
export interface DatasetSyncTarget {
  readonly kind: "dataset"
  readonly dataset: DatasetDefinition
}

/**
 * Connector-scoped read handler used by batch sync definitions.
 *
 * This intentionally uses TypeScript's method-parameter bivariance behavior so syncs with
 * different checkpoint types can still be stored as general `SyncDefinition[]` values. The
 * builder still gives users precise `context.checkpoint` and `setCheckpoint(...)` types when
 * they author a sync.
 */
export type SyncReadHandler<
  TAdapter extends ConnectorAdapter,
  TCheckpoint = never,
  TMode extends SyncMode = SyncMode,
> = {
  bivarianceHack(
    client: ConnectorClient<TAdapter>,
    context: SyncReadContext<TCheckpoint>
  ): SyncReadResult<TMode> | Promise<SyncReadResult<TMode>>
}["bivarianceHack"]

/**
 * Inert sync definition registered with Sixb.
 *
 * V1 supports batch syncs only. Definitions are declarative metadata and do not
 * start any background work on their own.
 */
export interface SyncDefinition<
  TId extends string = string,
  TConnector extends ConnectorDefinition<string, ConnectorAdapter> = ConnectorDefinition<
    string,
    ConnectorAdapter
  >,
  TCheckpoint = unknown,
  TMode extends SyncMode = SyncMode,
> {
  readonly kind: "sync"
  readonly id: TId
  readonly config: BatchSyncDefinitionConfig<TMode>
  readonly triggers: readonly ScheduleReference[]
  readonly connector: TConnector
  readonly read: SyncReadHandler<TConnector["adapter"], TCheckpoint, TMode>
  readonly target: DatasetSyncTarget
}

export interface SyncTargetBuilder<
  TId extends string = string,
  TConnector extends ConnectorDefinition<string, ConnectorAdapter> = ConnectorDefinition<
    string,
    ConnectorAdapter
  >,
  TCheckpoint = never,
  TMode extends SyncMode = SyncMode,
> {
  intoDataset<TDataset extends DatasetDefinition>(
    dataset: TMode extends "merge"
      ? TDataset & { readonly primaryKey: DatasetPrimaryKey }
      : TDataset
  ): SyncDefinition<TId, TConnector, TCheckpoint, TMode>
}

export interface SyncReadBuilder<
  TId extends string = string,
  TConnector extends ConnectorDefinition<string, ConnectorAdapter> = ConnectorDefinition<
    string,
    ConnectorAdapter
  >,
  TCheckpoint = never,
  TMode extends SyncMode = SyncMode,
> {
  read(
    handler: SyncReadHandler<TConnector["adapter"], TCheckpoint, TMode>
  ): SyncTargetBuilder<TId, TConnector, TCheckpoint, TMode>
}

export interface SyncBuilder<
  TId extends string = string,
  TCheckpoint = never,
  TMode extends SyncMode = SyncMode,
> {
  when(schedule: ScheduleDefinition): SyncBuilder<TId, TCheckpoint, TMode>
  checkpoint<TNextCheckpoint>(): SyncBuilder<TId, TNextCheckpoint, TMode>
  from<TConnector extends ConnectorDefinition<string, ConnectorAdapter>>(
    connector: TConnector
  ): SyncReadBuilder<TId, TConnector, TCheckpoint, TMode>
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
    (value.config.mode === "snapshot" ||
      value.config.mode === "append" ||
      value.config.mode === "merge") &&
    Array.isArray(value.triggers) &&
    (value.triggers as unknown[]).every((reference) => isScheduleReference(reference)) &&
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
