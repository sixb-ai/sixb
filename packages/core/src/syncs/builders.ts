import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { ScheduleDefinition } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import type { RunTrigger } from "../triggers"
import { SyncValidationError } from "./errors"
import type {
  BatchSyncConfig,
  BatchSyncDefinitionConfig,
  SyncBuilder,
  SyncDefinition,
  SyncReadBuilder,
  SyncTargetBuilder,
} from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new SyncValidationError(`Sync ${field} must not be empty.`)
  }
}

function assertDataset(dataset: DatasetDefinition): void {
  assertNonEmpty(dataset.id, "dataset id")
}

function normalizeBatchSyncConfig(options: BatchSyncConfig | undefined): BatchSyncDefinitionConfig {
  const mode = options?.mode ?? "snapshot"

  if (mode !== "snapshot" && mode !== "append") {
    throw new SyncValidationError(
      `Invalid sync mode '${String(mode)}'. Expected 'snapshot' or 'append'.`
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
 * V1 supports `snapshot` and `append` modes with optional triggers and checkpoints.
 */
export function defineSync<TId extends string>(
  id: TId,
  options?: BatchSyncConfig
): SyncBuilder<TId> {
  assertNonEmpty(id, "id")

  const config = normalizeBatchSyncConfig(options)
  const triggers: RunTrigger[] = []

  function createBuilder<TCheckpoint>(): SyncBuilder<TId, TCheckpoint> {
    const builder: SyncBuilder<TId, TCheckpoint> = {
      when(trigger: ScheduleDefinition | RunTrigger): SyncBuilder<TId, TCheckpoint> {
        if (isScheduleDefinition(trigger)) {
          triggers.push({ type: "schedule", scheduleId: trigger.id })
        } else {
          triggers.push(trigger)
        }
        return builder
      },
      checkpoint<TNextCheckpoint>(): SyncBuilder<TId, TNextCheckpoint> {
        return createBuilder<TNextCheckpoint>()
      },
      from<TConnector extends ConnectorDefinition>(
        connector: TConnector
      ): SyncReadBuilder<TId, TConnector, TCheckpoint> {
        return {
          read(handler): SyncTargetBuilder<TId, TConnector, TCheckpoint> {
            return {
              intoDataset(
                dataset: DatasetDefinition
              ): SyncDefinition<TId, TConnector, TCheckpoint> {
                assertDataset(dataset)

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
