import type {
  ActionDefinition,
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  ActionSubject,
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
  readonly subject: ActionSubject
  readonly params: Readonly<Record<string, unknown>>
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
