import { findActionEditCommit } from "@sixb/core/internal/actions"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { ActionRunFailure, ActionRunRecord } from "@sixb/core/storage"
import { isTerminalActionRun } from "@sixb/core/storage"
import { actionWorkerError } from "../errors"
import type { ActionRunResult, RunActionJobInput } from "../types"

export function requireFinishedAt(runId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw actionWorkerError(`Action run '${runId}' finished without a finishedAt timestamp.`)
}

/**
 * Decides whether a redelivered `running` run reached a resumable boundary.
 *
 * A succeeded writeback or an authoritative ontology commit for this run means the previous attempt
 * got far enough that resuming is safe; anything earlier is treated as a lost lease.
 */
export async function resolveRedeliveredRunningRun(
  input: RunActionJobInput,
  run: ActionRunRecord
): Promise<
  | { readonly kind: "resume"; readonly run: ActionRunRecord }
  | { readonly kind: "finished"; readonly result: ActionRunResult }
> {
  let resolution: Awaited<ReturnType<typeof resolveRunningRunUnderFence>>
  try {
    resolution = await resolveRunningRunUnderFence(input, run)
  } catch (error) {
    const latest = await input.runtime.actionRunsStorage.getById({
      projectId: input.runtime.id,
      id: input.job.id,
    })
    if (latest && isTerminalActionRun(latest)) {
      return { kind: "finished", result: skippedResult(input, latest) }
    }
    throw error
  }

  if (resolution.kind === "resume") return resolution
  reportRedeliveryFailure(input, resolution.run)
  return {
    kind: "finished",
    result: failedResult(input.job.id, input.job.actionId, resolution.run, resolution.failure),
  }
}

async function resolveRunningRunUnderFence(input: RunActionJobInput, run: ActionRunRecord) {
  return input.runtime.storage.transaction(
    async (storage) => {
      if (!storage.actionRuns) {
        throw actionWorkerError(
          "Action workers require transactional Action materialization fencing."
        )
      }
      const locked = await storage.actionRuns.lockForMaterialization({
        projectId: input.runtime.id,
        actionId: input.job.actionId,
        runId: run.id,
      })
      const commit = await findActionEditCommit({
        storage,
        projectId: input.runtime.id,
        runId: run.id,
      })
      if (locked.writeback?.status === "succeeded" || commit) {
        return { kind: "resume" as const, run: locked }
      }

      const failure = redeliveryFailure(input.job.id, locked)
      const finished = await storage.actionRuns.finish({
        projectId: input.runtime.id,
        id: input.job.id,
        status: "failed",
        phase: failure.phase,
        error: failure,
      })
      return { kind: "failed" as const, run: finished, failure }
    },
    { isolation: "serializable" }
  )
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

function redeliveryFailure(runId: string, run: ActionRunRecord): ActionRunFailure {
  // Decided here, not caught: there is no thrown error to unwrap into the record.
  return {
    code: "queue.lease_lost",
    message: `Action run '${runId}' was redelivered while already running. The previous worker may have lost its queue lease or crashed before reaching a resumable phase boundary.`,
    phase: run.phase ?? "validation",
  }
}

function reportRedeliveryFailure(input: RunActionJobInput, run: ActionRunRecord): void {
  const error = actionWorkerError(run.error?.message ?? `Action run '${run.id}' lost its lease.`)
  reportRunFailure(input.runtime.sixb, error, {
    projectId: input.runtime.id,
    occurredAt: run.finishedAt,
    attempt: input.attempt,
    run: {
      kind: "action",
      runId: input.job.id,
      actionId: input.job.actionId,
    },
  })
}

function skippedResult(input: RunActionJobInput, run: ActionRunRecord): ActionRunResult {
  return {
    id: input.job.id,
    actionId: input.job.actionId,
    subject: run.subject,
    status: run.status,
    skipped: true,
    record: run,
  }
}
