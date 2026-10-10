import { reportRunFailure } from "../../error-reporting/capability"
import { createSixbError } from "../../errors/internal"
import type { ActionRunFailure, RecordActionRunInput } from "../../storage"
import { ActionRunError } from "../../storage"
import type { CommittedActionRun } from "./edits-commit"
import { runActionEffects } from "./effects"
import { isActionPhaseFailure, toActionRunFailure, unwrapActionPhaseError } from "./normalize"
import { executeActionPhases } from "./phases"
import type { ActionRunSignals } from "./signals"
import { ActionRunState, type FailedActionRunRecord } from "./state"
import type { ActionRunContext, ActionRunOutcome, RunActionInput } from "./types"

/**
 * A run that ended, but whose terminal record could not be written.
 *
 * It carries that record, so that whoever reports this error still reports how the run ended. Its
 * cause is the error that kept the record from being written.
 */
export class UnrecordedActionRunError extends Error {
  override readonly name = "UnrecordedActionRunError"

  constructor(
    readonly record: RecordActionRunInput,
    options: { readonly cause: unknown }
  ) {
    super(`[Sixb] Action run '${record.id}' ended, but its record could not be written.`, options)
  }
}

/**
 * Execute a requested run to its end, and record it once.
 *
 * A run with edits is recorded by the commit of its edits; any other run, succeeded or failed, is
 * recorded as soon as it ends. The run's effects are left to the caller to start: see
 * {@link ActionRunOutcome.effects}. This rejects when the run cannot execute here, or with an
 * {@link UnrecordedActionRunError} when its record cannot be written.
 */
export async function runAction(input: RunActionInput): Promise<ActionRunOutcome> {
  const { runtime, run, signals } = input
  const ids = { actionId: run.actionId, runId: run.id }

  if (run.projectId !== runtime.id) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${run.id}' belongs to project '${run.projectId}', not '${runtime.id}'.`,
      { details: { ...ids, durableProjectId: run.projectId } }
    )
  }

  const state = new ActionRunState(run, new Date())
  const action = runtime.actions.getById(run.actionId)
  if (!action) {
    const message = `[Sixb] Unknown action '${run.actionId}'.`
    const error = createSixbError("internal.unexpected", message, { details: ids })
    const failure = toActionRunFailure(error, "validation", { ...ids, at: new Date() })
    return recordFailure(runtime, state.failed(failure), error)
  }

  let committed: CommittedActionRun | null
  try {
    committed = await executeActionPhases({ runtime, action, state, signals })
  } catch (error) {
    return recordFailure(runtime, state.failed(runFailure(error, state, signals)), error)
  }

  if (!committed) return recordRun(runtime, state.succeeded())
  // A commit that already existed recorded the run with it, for another request.
  if (!committed.commit.created) return findRecordedRun(runtime, committed.record)
  const { commit } = committed
  return {
    record: committed.record,
    recorded: true,
    ...(action.phases.effects
      ? {
          effects: () =>
            runActionEffects({
              runtime,
              action,
              state,
              commit,
              startDeadline: () => signals.startEffects(),
            }),
        }
      : {}),
  }
}

/**
 * The failure a run that threw records.
 *
 * A failed writeback fails the run with the writeback's own failure. Otherwise, only a run stopped
 * before its boundary is the caller's or the deadline's doing. Past it, or when a phase classified
 * its error before anything aborted, the run failed on its own merits.
 */
function runFailure(
  error: unknown,
  state: ActionRunState,
  signals: ActionRunSignals
): ActionRunFailure {
  if (state.writeback?.status === "failed") return state.writeback.error
  const stopped =
    !state.pastBoundary && signals.beforeBoundary.aborted && !isActionPhaseFailure(error)
  return toActionRunFailure(stopped ? signals.stopReason() : error, state.phase, {
    actionId: state.run.actionId,
    runId: state.run.id,
    at: new Date(),
  })
}

/**
 * Record a failed run, and report its failure to `onError` once this request recorded it. A run its
 * caller cancelled is not reported: it did not fail on its own.
 */
async function recordFailure(
  runtime: ActionRunContext,
  record: FailedActionRunRecord,
  error: unknown
): Promise<ActionRunOutcome> {
  const outcome = await recordRun(runtime, record)
  if (outcome.recorded && record.error.code !== "runtime.cancelled") {
    reportRunFailure(runtime.errorReporterHost, unwrapActionPhaseError(error), {
      projectId: runtime.id,
      runKind: "action",
      run: { runId: record.id, actionId: record.actionId },
      failure: record.error,
    })
  }
  return outcome
}

/**
 * Write a run's terminal record. A run id is recorded once: when a concurrent request for the same
 * run id recorded it first, with the same request, its record answers this one too.
 */
async function recordRun(
  runtime: ActionRunContext,
  record: RecordActionRunInput
): Promise<ActionRunOutcome> {
  try {
    return { record: await runtime.actionRunsStorage.record(record), recorded: true }
  } catch (error) {
    if (error instanceof ActionRunError) return findRecordedRun(runtime, record, error)
    throw new UnrecordedActionRunError(record, { cause: error })
  }
}

/**
 * The record another request wrote for this run. Whether it answers this request is the request's
 * to decide, under the checks any record it finds gets.
 */
async function findRecordedRun(
  runtime: ActionRunContext,
  record: RecordActionRunInput,
  cause?: unknown
): Promise<ActionRunOutcome> {
  try {
    const stored = await runtime.actionRunsStorage.getById({
      projectId: record.projectId,
      id: record.id,
    })
    if (!stored) {
      throw (
        cause ?? new ActionRunError(`[Sixb] Action run '${record.id}' committed without a record.`)
      )
    }
    return { record: stored, recorded: false }
  } catch (error) {
    throw new UnrecordedActionRunError(record, { cause: error })
  }
}
