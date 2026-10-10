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
import type { ExecutionRecord } from "../../storage/executions"
import { runAction } from "./run-action"
import { ActionRunSignals } from "./signals"
import type { ActionRunContext, ActionRunOutcome, PendingActionRun } from "./types"

/** What executing a stored Action run needs from its host. */
export interface ActionRunHost extends PrimitiveExecutionHost {
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "actions">
}

export interface ExecuteActionRunInput {
  readonly run: PendingActionRun
  /** The durable execution the run was requested under. */
  readonly execution: ExecutionRecord
  /** Cancels the run before its irreversible boundary. */
  readonly signal?: AbortSignal
  /** Test-only override of the 30-second deadlines of the run and of its effects. */
  readonly timeoutMs?: number
}

/**
 * The model-call attempt an Action run accounts under.
 *
 * Model accounting records every call against an execution attempt. A run executes once, in the
 * process that requested it, so it is always the first.
 */
const MODEL_EXECUTION_ATTEMPT = 1

/**
 * Execute a requested Action run inside the durable execution it was requested under, and record it.
 *
 * Binds the Action's primitive scope to that execution, then runs the phases under the run's
 * deadline and the caller's signal. Its effects, when it has any, are left to start: see
 * {@link ActionRunOutcome.effects}.
 */
export async function executeActionRun(
  host: ActionRunHost,
  input: ExecuteActionRunInput
): Promise<ActionRunOutcome> {
  const { run, execution } = input
  const actionRuns = requireActionRunStorage(host, run.id)
  const signals = new ActionRunSignals({
    actionId: run.actionId,
    runId: run.id,
    caller: input.signal,
    timeoutMs: input.timeoutMs,
  })

  try {
    const bound = bindDurablePrimitiveExecution(host, {
      // Model calls stop with their phase through the `signal` a handler forwards to them. Binding
      // the run's deadline here would also stop the embedding calls behind the vector reads that
      // edits make past the boundary, which must always finish.
      modelExecution: { attempt: MODEL_EXECUTION_ATTEMPT, signal: signals.uninterruptible },
      execution,
      primitive: { kind: "action", id: run.actionId, runId: run.id },
    })
    return await runAction({
      runtime: buildActionContext(host, actionRuns, bound),
      run,
      signals,
    })
  } finally {
    signals.dispose()
  }
}

function requireActionRunStorage(host: ActionRunHost, runId: string): ActionRunStorage {
  const actionRuns = host.storage.actionRuns
  if (!actionRuns) {
    throw createSixbError(
      "internal.unexpected",
      "[Sixb] Action execution requires storage.actionRuns support.",
      { details: { runId } }
    )
  }
  return actionRuns
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
