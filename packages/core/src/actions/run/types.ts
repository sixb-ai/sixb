import type { BlobsRuntime } from "../../blob-storage/execution"
import type { ConnectorRuntime } from "../../connectors/execution"
import type { DomainEventLog } from "../../events"
import type { LoggingService } from "../../logging/service"
import type { ModelsRuntime } from "../../models/generation-types"
import type { ObjectsRuntime } from "../../objects/execution"
import type { SixbDefinitions } from "../../runtime/definitions"
import type { OntologyMutationRuntime } from "../../runtime/ontology-mutations"
import type { ActionRunFailure, ActionRunRecord, ActionRunStorage, Storage } from "../../storage"
import type { ActionsRuntime } from "../execution"
import type { ActionSubject } from "../types"

/** Execution-bound primitives exposed to Action phase handlers. */
export interface ActionExecutionFacade {
  readonly models: ModelsRuntime
  readonly objects: ObjectsRuntime
  readonly actions: ActionsRuntime
  readonly connector: ConnectorRuntime
  readonly blobs: BlobsRuntime
}

export interface ActionRunContext {
  readonly id: string
  readonly errorReporterHost: object
  readonly events: DomainEventLog
  readonly logging?: LoggingService
  readonly storage: Storage
  readonly actionRunsStorage: ActionRunStorage
  readonly ontologyMutations: OntologyMutationRuntime
  readonly sixb: ActionExecutionFacade
  readonly actions: Pick<SixbDefinitions["actions"], "getById">
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
  readonly runtime: ActionRunContext
  readonly job: ActionJob
  /** Durable run loaded before the execution scope is restored. */
  readonly run: ActionRunRecord
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
