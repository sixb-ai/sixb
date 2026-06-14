import type { ActionDefinition, ActionRunFailure, ActionRunRecord } from "@sixb/core"
import { isTerminalActionRun } from "@sixb/core"
import { ActionWorkerError } from "../errors"
import type { ActionRunResult, RunActionJobInput } from "../types"

export function requireFinishedAt(runId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw new ActionWorkerError(`Action run '${runId}' finished without a finishedAt timestamp.`)
}

export function canResumeRunningRun(run: ActionRunRecord, action: ActionDefinition): boolean {
  if (run.writeback?.status === "succeeded") {
    return true
  }
  if (run.commit) {
    return true
  }
  if (!action.phases.writeback && !action.phases.edits && run.phase === "validation") {
    return false
  }
  return false
}

export function failedResult(
  runId: string,
  actionId: string,
  run: ActionRunRecord,
  failure: ActionRunFailure
): ActionRunResult {
  return {
    id: runId,
    actionId,
    subject: run.subject,
    status: "failed",
    startedAt: run.startedAt ?? run.queuedAt,
    finishedAt: requireFinishedAt(runId, run.finishedAt),
    error: failure,
    record: run,
  }
}

export async function failRedeliveredRunningRun(
  input: RunActionJobInput,
  existingRun: ActionRunRecord
): Promise<ActionRunResult> {
  const { runtime, job } = input
  const error = new ActionWorkerError(
    `Action run '${job.id}' was redelivered while already running. The previous worker may have lost its queue lease or crashed before reaching a resumable phase boundary.`
  )
  const failure: ActionRunFailure = {
    name: "ActionRunLeaseLostError",
    message: error.message,
    phase: existingRun.phase ?? "validation",
  }

  const finishedRun = await runtime.actionRunsStorage
    .finish({
      projectId: runtime.id,
      id: job.id,
      status: "failed",
      phase: failure.phase,
      error: failure,
    })
    .catch(async (error) => {
      const latest = await runtime.actionRunsStorage.getById({
        projectId: runtime.id,
        id: job.id,
      })

      if (latest && isTerminalActionRun(latest)) {
        return latest
      }

      throw error
    })

  if (finishedRun.status !== "failed") {
    return {
      id: job.id,
      actionId: job.actionId,
      subject: finishedRun.subject,
      status: finishedRun.status,
      skipped: true,
      record: finishedRun,
    }
  }

  return {
    id: job.id,
    actionId: job.actionId,
    subject: finishedRun.subject,
    status: "failed",
    startedAt: existingRun.startedAt ?? existingRun.queuedAt,
    finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
    error: finishedRun.error ?? failure,
    record: finishedRun,
  }
}
