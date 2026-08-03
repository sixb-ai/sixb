import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { ActionRunRecord } from "@sixb/core/storage"
import { isTerminalActionRun, toActionRunFailure } from "@sixb/core/storage"
import { executeActionPhases } from "./action-execution/phases"
import {
  failedResult,
  requireFinishedAt,
  resolveRedeliveredRunningRun,
} from "./action-execution/results"
import { actionWorkerError } from "./errors"
import { throwIfAborted } from "./normalize"
import type { ActionRunResult, RunActionJobInput } from "./types"

export async function runActionJob(input: RunActionJobInput): Promise<ActionRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal

  throwIfAborted(signal)

  let existingRun = await runtime.actionRunsStorage.getById({
    projectId: runtime.id,
    id: job.id,
  })
  if (!existingRun) {
    throw actionWorkerError(`Action run '${job.id}' was not found.`)
  }
  if (existingRun.actionId !== job.actionId) {
    throw actionWorkerError(
      `Action job '${job.id}' references action '${job.actionId}' but the stored run references '${existingRun.actionId}'.`
    )
  }
  if (isTerminalActionRun(existingRun)) {
    return {
      id: job.id,
      actionId: job.actionId,
      subject: existingRun.subject,
      status: existingRun.status,
      skipped: true,
      record: existingRun,
    }
  }

  const action = runtime.getActionById(job.actionId)
  if (!action) {
    const error = actionWorkerError(`Unknown action '${job.actionId}'.`)
    const failure = toActionRunFailure(error, "validation")
    const finishedRun = await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: job.id,
      status: "failed",
      error: failure,
    })
    reportActionFailure(input, error, finishedRun)

    return failedResult(job.id, job.actionId, finishedRun, failure)
  }

  if (existingRun.status === "running") {
    const resolution = await resolveRedeliveredRunningRun(input, existingRun)
    if (resolution.kind === "finished") return resolution.result
    existingRun = resolution.run
  }
  if (existingRun.status !== "queued" && existingRun.status !== "running") {
    throw actionWorkerError(
      `Action run '${job.id}' cannot execute from status '${existingRun.status}'.`
    )
  }

  let activeRun: ActionRunRecord | null = null
  let startedRun: ActionRunRecord | null = null
  try {
    if (existingRun.status === "running") {
      startedRun = existingRun
      activeRun = existingRun
    } else {
      startedRun = await runtime.actionRunsStorage.start({
        projectId: runtime.id,
        id: job.id,
      })
      activeRun = startedRun
    }

    throwIfAborted(signal)

    const finalRun = await executeActionPhases({
      runtime,
      action,
      run: startedRun,
      signal,
      updateActiveRun(run) {
        activeRun = run
      },
    })

    return {
      id: job.id,
      actionId: job.actionId,
      subject: finalRun.subject,
      status: "succeeded",
      startedAt: startedRun.startedAt ?? startedRun.queuedAt,
      finishedAt: requireFinishedAt(job.id, finalRun.finishedAt),
      record: finalRun,
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed"
    const failure = toActionRunFailure(
      error,
      status === "cancelled" ? "cancelled" : (activeRun?.phase ?? "validation")
    )

    const finishedRun = await runtime.actionRunsStorage
      .finish({
        projectId: runtime.id,
        id: job.id,
        status,
        error: failure,
      })
      .catch(() => null)

    if (!finishedRun) {
      throw error
    }
    if (status === "failed" && finishedRun.status === "failed") {
      reportActionFailure(input, error, finishedRun)
    }

    const startedAt = startedRun?.startedAt ?? finishedRun.startedAt ?? finishedRun.queuedAt
    return {
      id: job.id,
      actionId: job.actionId,
      subject: finishedRun.subject,
      status,
      startedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      error: failure,
      record: finishedRun,
    }
  }
}

function reportActionFailure(input: RunActionJobInput, error: unknown, run: ActionRunRecord): void {
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
