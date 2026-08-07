import type { ConnectorDefinition } from "../connectors"
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

/**
 * Define a batch sync that reads from one connector and writes into one dataset.
 *
 * The returned definition is inert and safe to export from `syncs/` modules.
 * Supports `snapshot`, `append`, and keyed `merge` modes with optional triggers and checkpoints.
 */
type SyncModeFromConfig<TConfig extends BatchSyncConfig | undefined> = TConfig extends {
  readonly mode: infer TMode extends SyncMode
}
  ? TMode
  : "snapshot"

export function defineSync<
  TId extends string,
  const TConfig extends BatchSyncConfig | undefined = undefined,
>(id: TId, options?: TConfig): SyncBuilder<TId, never, SyncModeFromConfig<TConfig>> {
  assertNonEmpty(id, "id")

  type TMode = SyncModeFromConfig<TConfig>
  const config = normalizeBatchSyncConfig(options) as BatchSyncDefinitionConfig<TMode>
  const triggers: ScheduleReference[] = []

  function createBuilder<TCheckpoint>(): SyncBuilder<TId, TCheckpoint, TMode> {
    const builder: SyncBuilder<TId, TCheckpoint, TMode> = {
      when(schedule: ScheduleDefinition): SyncBuilder<TId, TCheckpoint, TMode> {
        if (!isScheduleDefinition(schedule)) {
          throw new SyncValidationError("Sync .when(...) only accepts schedules.")
        }
        triggers.push({ type: "schedule", scheduleId: schedule.id })
        return builder
      },
      checkpoint<TNextCheckpoint>(): SyncBuilder<TId, TNextCheckpoint, TMode> {
        return createBuilder<TNextCheckpoint>()
      },
      from<TConnector extends ConnectorDefinition>(
        connector: TConnector
      ): SyncReadBuilder<TId, TConnector, TCheckpoint, TMode> {
        return {
          read(handler): SyncTargetBuilder<TId, TConnector, TCheckpoint, TMode> {
            return {
              intoDataset(
                dataset: DatasetDefinition
              ): SyncDefinition<TId, TConnector, TCheckpoint, TMode> {
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
