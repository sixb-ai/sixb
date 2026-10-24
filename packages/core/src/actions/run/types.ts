import type { BlobsRuntime } from "../../blob-storage/execution"
import type { ConnectorRuntime } from "../../connectors/execution"
import type { AuthorizablePrincipal } from "../../execution/types"
import type { LoggingService } from "../../logging/service"
import type { ModelsRuntime } from "../../models/generation-types"
import type { ObjectsRuntime } from "../../objects/execution"
import type { SixbDefinitions } from "../../runtime/definitions"
import type { OntologyMutationRuntime } from "../../runtime/ontology-mutations"
import type { ActionRunRecord, ActionRunStorage, ObjectRow, Storage } from "../../storage"
import type { UsersRuntime } from "../../users"
import type { ActionsRuntime } from "../execution"
import type { ActionRunSignals } from "./signals"

/** Execution-bound primitives exposed to Action phase handlers. */
export interface ActionExecutionFacade {
  readonly models: ModelsRuntime
  readonly objects: ObjectsRuntime
  readonly actions: ActionsRuntime
  readonly connector: ConnectorRuntime
  readonly blobs: BlobsRuntime
  readonly users: UsersRuntime
}

export interface ActionRunContext {
  readonly id: string
  readonly errorReporterHost: object
  readonly logging?: LoggingService
  readonly storage: Storage
  readonly actionRunsStorage: ActionRunStorage
  readonly ontologyMutations: OntologyMutationRuntime
  readonly sixb: ActionExecutionFacade
  readonly actions: Pick<SixbDefinitions["actions"], "getById">
  /** Who started the chain of executions the run belongs to, when a principal did. */
  readonly requestedBy: AuthorizablePrincipal | undefined
  /** Reads the subject as its requester sees it: see {@link ReadSubjectAsRequester}. */
  readonly readSubjectAsRequester?: ReadSubjectAsRequester
}

/**
 * Reads the run's subject through its requester's reader. Present when the requester views the
 * subject's type only through a condition: the run then acts only on a state its requester sees.
 */
export type ReadSubjectAsRequester = (subject: {
  readonly objectTypeId: string
  readonly primaryId: string
}) => Promise<ObjectRow | null>

/**
 * A requested run that has not ended: the request it executes, under the durable execution created
 * for it. Nothing else about it is stored until its terminal record is written.
 */
export type PendingActionRun = Pick<
  ActionRunRecord,
  "id" | "projectId" | "executionId" | "actionId" | "subject" | "params" | "idempotencyKey"
>

export interface RunActionInput {
  readonly runtime: ActionRunContext
  readonly run: PendingActionRun
  readonly signals: ActionRunSignals
}

/** How a request's run ended. */
export interface ActionRunOutcome {
  readonly record: ActionRunRecord
  /**
   * Whether this request wrote the record. When it did not, a concurrent request for the same run
   * id recorded the run first, and the record is that request's, whatever it asked for.
   */
  readonly recorded: boolean
  /**
   * Runs the run's effects and records their outcome. The request starts it once it returns the
   * record, and does not wait for it. An effects failure does not reject it: it is recorded on the
   * run.
   */
  readonly effects?: () => Promise<void>
}
