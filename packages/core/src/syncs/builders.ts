import type { AnyConnectorAdapter, ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { ScheduleDefinition, ScheduleReference } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import { SyncValidationError } from "./errors"
import type {
  BatchSyncConfig,
  BatchSyncDefinitionConfig,
  SyncBuilder,
  SyncDefinition,
  SyncMode,
  SyncReadBuilder,
  SyncTargetBuilder,
} from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new SyncValidationError(`Sync ${field} must not be empty.`)
  }
}

function assertDataset(dataset: DatasetDefinition, mode: SyncMode): void {
  assertNonEmpty(dataset.id, "dataset id")
  if (mode === "merge" && dataset.primaryKey === undefined) {
    throw new SyncValidationError(`Merge sync dataset '${dataset.id}' must define a primaryKey.`)
  }
}

function normalizeBatchSyncConfig(options: BatchSyncConfig | undefined): BatchSyncDefinitionConfig {
  const mode = options?.mode ?? "snapshot"

  if (mode !== "snapshot" && mode !== "append" && mode !== "merge") {
    throw new SyncValidationError(
      `Invalid sync mode '${String(mode)}'. Expected 'snapshot', 'append', or 'merge'.`
    )
  }

  return {
    kind: "batch",
    mode,
  }
}

type DefaultBatchSyncConfig = Omit<BatchSyncConfig, "mode"> & { readonly mode?: undefined }

/**
 * Define a batch sync that reads from one connector and writes into one dataset.
 *
 * The returned definition is inert and safe to export from `syncs/` modules.
 * Supports `snapshot`, `append`, and keyed `merge` modes with optional triggers and checkpoints.
 */
export function defineSync<TId extends string>(
  id: TId,
  options?: DefaultBatchSyncConfig
): SyncBuilder<TId, never, "snapshot">
export function defineSync<TId extends string, const TMode extends SyncMode>(
  id: TId,
  options: BatchSyncConfig<TMode> & { readonly mode: TMode }
): SyncBuilder<TId, never, TMode>
export function defineSync<TId extends string>(
  id: TId,
  options: BatchSyncConfig
): SyncBuilder<TId, never, SyncMode>
export function defineSync<TId extends string>(
  id: TId,
  options?: BatchSyncConfig
): SyncBuilder<TId, never, SyncMode> {
  assertNonEmpty(id, "id")

  const config = normalizeBatchSyncConfig(options)
  const triggers: ScheduleReference[] = []

  function createBuilder<TCheckpoint>(): SyncBuilder<TId, TCheckpoint, SyncMode> {
    const builder: SyncBuilder<TId, TCheckpoint, SyncMode> = {
      when(schedule: ScheduleDefinition): SyncBuilder<TId, TCheckpoint, SyncMode> {
        if (!isScheduleDefinition(schedule)) {
          throw new SyncValidationError("Sync .when(...) only accepts schedules.")
        }
        triggers.push({ type: "schedule", scheduleId: schedule.id })
        return builder
      },
      checkpoint<TNextCheckpoint>(): SyncBuilder<TId, TNextCheckpoint, SyncMode> {
        return createBuilder<TNextCheckpoint>()
      },
      from<TConnector extends ConnectorDefinition<string, AnyConnectorAdapter>>(
        connector: TConnector
      ): SyncReadBuilder<TId, TConnector, TCheckpoint, SyncMode> {
        return {
          read(handler): SyncTargetBuilder<TId, TConnector, TCheckpoint, SyncMode> {
            return {
              intoDataset(
                dataset: DatasetDefinition
              ): SyncDefinition<TId, TConnector, TCheckpoint, SyncMode> {
                assertDataset(dataset, config.mode)

                return {
                  kind: "sync",
                  id,
                  config,
                  triggers,
                  connector,
                  read: handler,
                  target: {
                    kind: "dataset",
                    dataset,
                  },
                }
              },
            }
          },
        }
      },
    }

    return builder
  }

  return createBuilder<never>()
}
