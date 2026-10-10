import { reportRunFailure } from "../../error-reporting/capability"
import { createSixbError } from "../../errors/internal"
import type { ActionRunFailure, ActionRunRecord } from "../../storage"
import { isTerminalActionRun } from "../../storage"
import { isActionPhaseFailure, toActionRunFailure, unwrapActionPhaseError } from "./normalize"
import { executeActionPhases, isPastBoundary } from "./phases"
import { failedResult, requireFinishedAt, resolveRedeliveredRunningRun } from "./results"
import type { ActionRunResult, RunActionInput } from "./types"

/**
 * A run that ended, but whose outcome could not be recorded.
 *
 * It carries the failure the run would have recorded, so that whoever reports this error still
 * reports how the run ended. Its cause is the error that kept the outcome from being recorded.
 */
export class UnrecordedActionRunError extends Error {
  override readonly name = "UnrecordedActionRunError"

  constructor(
    readonly failure: ActionRunFailure,
    options: { readonly cause: unknown }
  ) {
    super(
      `[Sixb] Action run '${failure.details.runId}' ended, but its outcome could not be recorded.`,
      options
    )
  }
}

/**
 * Run a stored Action run to a terminal status.
 *
 * A run that is already terminal comes back skipped. Otherwise its outcome is recorded on the run
 * before this resolves; it rejects when the run cannot execute here, or with an
 * {@link UnrecordedActionRunError} when its outcome cannot be recorded.
 */
export async function runAction(input: RunActionInput): Promise<ActionRunResult> {
  const { runtime, signals } = input
  const { id: runId, actionId } = input.run

  let existingRun = input.run
  if (existingRun.projectId !== runtime.id) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${runId}' belongs to project '${existingRun.projectId}', not '${runtime.id}'.`,
      { details: { actionId, runId, durableProjectId: existingRun.projectId } }
    )
  }
  if (isTerminalActionRun(existingRun)) {
    return {
      id: runId,
      actionId,
      subject: existingRun.subject,
      status: existingRun.status,
      skipped: true,
      record: existingRun,
    }
  }

  const action = runtime.actions.getById(actionId)
  if (!action) {
    const error = createSixbError("internal.unexpected", `[Sixb] Unknown action '${actionId}'.`, {
      details: { actionId, runId },
    })
    const failedAt = new Date()
    const failure = toActionRunFailure(error, "validation", { actionId, runId, at: failedAt })
    const finishedRun = await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: runId,
      status: "failed",
      finishedAt: failedAt,
      error: failure,
    })
    reportActionFailure(input, error, failure)

    return failedResult(runId, actionId, finishedRun, failure)
  }

  if (existingRun.status === "running") {
    const resolution = await resolveRedeliveredRunningRun(input, existingRun)
    if (resolution.kind === "finished") return resolution.result
    existingRun = resolution.run
  }
  if (existingRun.status !== "queued" && existingRun.status !== "running") {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${runId}' cannot execute from status '${existingRun.status}'.`,
      { details: { actionId, runId } }
    )
  }

  let activeRun: ActionRunRecord | null = null
  let startedRun: ActionRunRecord | null = null
  try {
    startedRun =
      existingRun.status === "running"
        ? existingRun
        : await runtime.actionRunsStorage.start({ projectId: runtime.id, id: runId })
    activeRun = startedRun

    const finalRun = await executeActionPhases({
      runtime,
      action,
      run: startedRun,
      signals,
      updateActiveRun(run) {
        activeRun = run
      },
    })

    return {
      id: runId,
      actionId,
      subject: finalRun.subject,
      status: "succeeded",
      startedAt: startedRun.startedAt ?? startedRun.queuedAt,
      finishedAt: requireFinishedAt({ actionId, runId, finishedAt: finalRun.finishedAt }),
      record: finalRun,
    }
  } catch (error) {
    const nativeError = unwrapActionPhaseError(error)
    // Only a run stopped before its boundary is the caller's or the deadline's doing. Past it, or
    // when a phase classified its error before anything aborted, the run failed on its own merits.
    const stopped =
      !isPastBoundary(activeRun) && signals.beforeBoundary.aborted && !isActionPhaseFailure(error)
    const status = stopped && signals.cancelled ? "cancelled" : "failed"
    const finishedAt = new Date()
    const writebackFailure =
      status === "failed" && activeRun?.writeback?.status === "failed"
        ? activeRun.writeback.error
        : undefined
    const failure =
      writebackFailure ??
      toActionRunFailure(
        stopped ? signals.beforeBoundary.reason : error,
        status === "cancelled" ? "cancelled" : (activeRun?.phase ?? "validation"),
        { actionId, runId, at: finishedAt }
      )

    let finishedRun: ActionRunRecord
    try {
      finishedRun = await runtime.actionRunsStorage.finish({
        projectId: runtime.id,
        id: runId,
        status,
        finishedAt,
        error: failure,
      })
    } catch (recordError) {
      throw new UnrecordedActionRunError(failure, { cause: recordError })
    }
    if (status === "failed" && finishedRun.status === "failed") {
      reportActionFailure(input, nativeError, failure)
    }

    return {
      id: runId,
      actionId,
      subject: finishedRun.subject,
      status,
      startedAt: startedRun?.startedAt ?? finishedRun.startedAt ?? finishedRun.queuedAt,
      finishedAt: requireFinishedAt({ actionId, runId, finishedAt: finishedRun.finishedAt }),
      error: failure,
      record: finishedRun,
    }
  }
}

function reportActionFailure(
  input: RunActionInput,
  error: unknown,
  failure: ActionRunFailure
): void {
  reportRunFailure(input.runtime.errorReporterHost, error, {
    projectId: input.runtime.id,
    attempt: input.attempt,
    runKind: "action",
    run: { runId: input.run.id, actionId: input.run.actionId },
    failure,
  })
}
