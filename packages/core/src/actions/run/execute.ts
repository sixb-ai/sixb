import { createSixbError } from "../../errors/internal"
import type { DomainEventLog } from "../../events"
import {
  type BoundPrimitiveExecution,
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "../../execution/primitive"
import type { LoggingService } from "../../logging/service"
import type { SixbDefinitions } from "../../runtime/definitions"
import type { ActionRunStorage, Storage } from "../../storage"
import { runActionJob } from "./run-action-job"
import type { ActionRunContext, ActionRunResult } from "./types"

/** What executing a stored Action run needs from its host. */
export interface ActionRunHost extends PrimitiveExecutionHost {
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "actions">
}

export interface ExecuteActionRunInput {
  readonly runId: string
  readonly signal: AbortSignal
  /** Delivery attempt, used to account model calls and to report failures. */
  readonly attempt: number
}

export interface ExecutedActionRun {
  readonly result: ActionRunResult
  /** Correlation id of the durable execution the run was requested under. */
  readonly correlationId: string
}

/**
 * Execute a stored Action run inside the durable execution it was requested under.
 *
 * Loads the run and its execution, binds the Action's primitive scope to that execution, then runs
 * the phases. A run that is already terminal comes back as a skipped result without invoking any
 * phase.
 */
export async function executeActionRun(
  host: ActionRunHost,
  input: ExecuteActionRunInput
): Promise<ExecutedActionRun> {
  const actionRuns = host.storage.actionRuns
  if (!actionRuns) {
    throw createSixbError(
      "internal.unexpected",
      "[Sixb] Action execution requires storage.actionRuns support.",
      { details: { runId: input.runId } }
    )
  }

  const run = await actionRuns.getById({ projectId: host.id, id: input.runId })
  if (!run) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${input.runId}' was not found.`,
      { details: { runId: input.runId } }
    )
  }

  const durableExecution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!durableExecution) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${run.id}' references missing execution '${run.executionId}'.`,
      {
        details: {
          actionId: run.actionId,
          runId: run.id,
          executionId: run.executionId,
        },
      }
    )
  }

  const execution = bindDurablePrimitiveExecution(host, {
    modelExecution: { attempt: input.attempt, signal: input.signal },
    execution: durableExecution,
    primitive: {
      kind: "action",
      id: run.actionId,
      runId: run.id,
    },
  })

  const result = await runActionJob({
    runtime: buildActionContext(host, actionRuns, execution),
    job: { id: run.id, actionId: run.actionId },
    run,
    signal: input.signal,
    attempt: input.attempt,
  })

  return { result, correlationId: durableExecution.correlationId }
}

function buildActionContext(
  host: ActionRunHost,
  actionRunsStorage: ActionRunStorage,
  execution: BoundPrimitiveExecution
): ActionRunContext {
  const sixb = {
    models: execution.sixb.models,
    objects: execution.sixb.objects,
    actions: execution.sixb.actions,
    connector: execution.sixb.connector,
    blobs: execution.sixb.blobs,
  }
  return {
    id: host.id,
    errorReporterHost: host,
    events: host.events,
    logging: host.logging,
    storage: host.storage,
    actionRunsStorage,
    ontologyMutations: execution.ontologyMutations,
    sixb,
    actions: host.definitions.actions,
  }
}
