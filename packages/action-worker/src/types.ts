import type {
  ActionSubject,
  ActionsRuntime,
  BlobsRuntime,
  ConnectorsRuntime,
  DomainEventLog,
  DynamicObjectsRuntime,
  Storage,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { OntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  ObjectRow,
} from "@sixb/core/storage"

export interface ActionWorkerSixbFacade {
  readonly blobs: Pick<BlobsRuntime, "put" | "open" | "stat">
  readonly connectors: Pick<ConnectorsRuntime, "connect">
  readonly objects: DynamicObjectsRuntime
  readonly actions: Pick<ActionsRuntime, "listForType">
}

export interface ActionWorkerContext {
  readonly id: string
  readonly errorReporterHost: object
  readonly events: DomainEventLog
  readonly logs?: LogsRuntime
  readonly storage: Storage
  readonly actionRunsStorage: ActionRunStorage
  readonly ontologyMutations: OntologyMutationRuntime
  readonly sixb: ActionWorkerSixbFacade
  readonly actions: Pick<ActionsRuntime, "getById">
}

export interface ActionJob {
  readonly id: string
  readonly actionId: string
}

interface BaseActionRunResult {
  readonly id: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly record: ActionRunRecord
}

export interface RunActionJobInput {
  readonly runtime: ActionWorkerContext
  readonly job: ActionJob
  readonly signal?: AbortSignal
  /** Queue delivery attempt, when invoked by ActionWorker. */
  readonly attempt?: number
}

export type ActionRunResult =
  | (BaseActionRunResult & {
      readonly status: "succeeded"
      readonly startedAt: Date
      readonly finishedAt: Date
    })
  | (BaseActionRunResult & {
      readonly status: "failed" | "cancelled"
      readonly startedAt: Date
      readonly finishedAt: Date
      readonly error: ActionRunFailure
    })
  | (BaseActionRunResult & {
      readonly status: ActionRunRecord["status"]
      readonly skipped: true
    })

export type ActionTargetRow = Pick<
  ObjectRow,
  "primaryId" | "objectTypeId" | "properties" | "createdAt" | "updatedAt"
>
