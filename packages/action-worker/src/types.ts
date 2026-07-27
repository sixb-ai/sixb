import type { ActionDefinition, ActionSubject, OntologySource, Sixb, Storage } from "@sixb/core"
import type { EventsRuntime } from "@sixb/core/internal/events"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { OntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  ObjectRow,
} from "@sixb/core/storage"

export interface ActionWorkerSixbFacade
  extends Pick<
    Sixb<readonly OntologySource[]>,
    | "blobStorage"
    | "connector"
    | "appendTelemetry"
    | "getActionsForType"
    | "getPrimaryPropertyId"
    | "getValueTypesById"
    | "isValidLinkTarget"
    | "objects"
    | "resolveObjectType"
  > {}

export interface ActionWorkerContext {
  readonly id: string
  readonly events: EventsRuntime
  readonly logs?: LogsRuntime
  readonly storage: Storage
  readonly actionRunsStorage: ActionRunStorage
  readonly ontologyMutations: OntologyMutationRuntime
  readonly sixb: ActionWorkerSixbFacade
  getActionById(actionId: string): ActionDefinition | null
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
