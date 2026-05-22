import type {
  ActionDefinition,
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  EventsRuntime,
  ObjectRow,
  OntologySource,
  Pario,
  Storage,
} from "@pario/core"

export interface ActionWorkerContext {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly actionRunsStorage: ActionRunStorage
  readonly pario: Pario<readonly OntologySource[]>
  getActionById(actionId: string): ActionDefinition | null
}

export interface ActionJob {
  readonly id: string
  readonly actionId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly params: Readonly<Record<string, unknown>>
}

export interface RunActionJobInput {
  readonly runtime: ActionWorkerContext
  readonly job: ActionJob
  readonly signal?: AbortSignal
}

export type ActionRunResult =
  | {
      readonly id: string
      readonly actionId: string
      readonly objectTypeId: string
      readonly primaryId: string
      readonly status: "succeeded"
      readonly startedAt: Date
      readonly finishedAt: Date
      readonly record: ActionRunRecord
    }
  | {
      readonly id: string
      readonly actionId: string
      readonly objectTypeId: string
      readonly primaryId: string
      readonly status: "failed" | "cancelled"
      readonly startedAt: Date
      readonly finishedAt: Date
      readonly error: ActionRunFailure
      readonly record: ActionRunRecord
    }
  | {
      readonly id: string
      readonly actionId: string
      readonly objectTypeId: string
      readonly primaryId: string
      readonly status: ActionRunRecord["status"]
      readonly skipped: true
      readonly record: ActionRunRecord
    }

export type ActionTargetRow = Pick<
  ObjectRow,
  "primaryId" | "objectTypeId" | "properties" | "createdAt" | "updatedAt"
>
