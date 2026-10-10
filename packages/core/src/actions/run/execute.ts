import { createSixbError } from "../../errors/internal"
import type { DomainEventLog } from "../../events"
import {
  type BoundPrimitiveExecution,
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "../../execution/primitive"
import type { LoggingService } from "../../logging/service"
import type { SixbDefinitions } from "../../runtime/definitions"
import type { ActionRunRecord, ActionRunStorage, Storage } from "../../storage"
import type { ExecutionRecord } from "../../storage/executions"
import { runAction } from "./run-action"
import { ActionRunSignals } from "./signals"
import type { ActionRunContext, ActionRunResult } from "./types"

/** What executing a stored Action run needs from its host. */
export interface ActionRunHost extends PrimitiveExecutionHost {
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "actions">
}

interface ActionRunExecutionOptions {
  /** Cancels the run before its irreversible boundary. */
  readonly signal?: AbortSignal
  /** Execution attempt, used to account model calls and to report failures. */
  readonly attempt: number
  /** Test-only override of the run's 30-second deadline. */
  readonly timeoutMs?: number
}

export interface ExecuteActionRunInput extends ActionRunExecutionOptions {
  readonly runId: string
}

export interface ExecutePersistedActionRunInput extends ActionRunExecutionOptions {
  readonly run: ActionRunRecord
  /** The durable execution the run was requested under. */
  readonly execution: ExecutionRecord
}

export interface ExecutedActionRun {
  readonly result: ActionRunResult
  /** Correlation id of the durable execution the run was requested under. */
  readonly correlationId: string
}

/**
 * Execute a stored Action run, loading it and the durable execution it was requested under.
 *
 * A run that is already terminal comes back as a skipped result without invoking any phase.
 */
export async function executeActionRun(
  host: ActionRunHost,
  input: ExecuteActionRunInput
): Promise<ExecutedActionRun> {
  const actionRuns = requireActionRunStorage(host, input.runId)
  const run = await actionRuns.getById({ projectId: host.id, id: input.runId })
  if (!run) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${input.runId}' was not found.`,
      { details: { runId: input.runId } }
    )
  }

  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!execution) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${run.id}' references missing execution '${run.executionId}'.`,
      { details: { actionId: run.actionId, runId: run.id, executionId: run.executionId } }
    )
  }

  return executePersistedActionRun(host, { ...input, run, execution })
}

/**
 * Execute an Action run its caller already holds, inside the durable execution it was requested
 * under.
 *
 * Binds the Action's primitive scope to that execution, then runs the phases under the run's
 * deadline and the caller's signal.
 */
export async function executePersistedActionRun(
  host: ActionRunHost,
  input: ExecutePersistedActionRunInput
): Promise<ExecutedActionRun> {
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
      modelExecution: { attempt: input.attempt, signal: signals.uninterruptible },
      execution,
      primitive: { kind: "action", id: run.actionId, runId: run.id },
    })
    const result = await runAction({
      runtime: buildActionContext(host, actionRuns, bound),
      run,
      signals,
      attempt: input.attempt,
    })
    return { result, correlationId: execution.correlationId }
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
