import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { createSixbError } from "@sixb/core/internal/errors"
import type { ActionRunFailure, ActionRunRecord } from "@sixb/core/storage"
import { isTerminalActionRun } from "@sixb/core/storage"
import { executeActionPhases } from "./action-execution/phases"
import {
  failedResult,
  requireFinishedAt,
  resolveRedeliveredRunningRun,
} from "./action-execution/results"
import { throwIfAborted, toActionRunFailure } from "./normalize"
import type { ActionRunResult, RunActionJobInput } from "./types"

export async function runActionJob(input: RunActionJobInput): Promise<ActionRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal

  throwIfAborted(signal)

  let existingRun = input.run
  if (
    existingRun.projectId !== runtime.id ||
    existingRun.id !== job.id ||
    existingRun.actionId !== job.actionId
  ) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Action job '${job.id}' does not match durable run '${existingRun.id}' in project '${existingRun.projectId}'.`,
      {
        details: {
          actionId: job.actionId,
          runId: job.id,
          durableActionId: existingRun.actionId,
          durableRunId: existingRun.id,
          durableProjectId: existingRun.projectId,
        },
      }
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

  const action = runtime.actions.getById(job.actionId)
  if (!action) {
    const error = createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Unknown action '${job.actionId}'.`,
      { details: { actionId: job.actionId, runId: job.id } }
    )
    const failedAt = new Date()
    const failure = toActionRunFailure(error, "validation", {
      actionId: job.actionId,
      runId: job.id,
      at: failedAt,
    })
    const finishedRun = await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: job.id,
      status: "failed",
      finishedAt: failedAt,
      error: failure,
    })
    reportActionFailure(input, error, failure)

    return failedResult(job.id, job.actionId, finishedRun, failure)
  }

  if (existingRun.status === "running") {
    const resolution = await resolveRedeliveredRunningRun(input, existingRun)
    if (resolution.kind === "finished") return resolution.result
    existingRun = resolution.run
  }
  if (existingRun.status !== "queued" && existingRun.status !== "running") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Action run '${job.id}' cannot execute from status '${existingRun.status}'.`,
      { details: { actionId: job.actionId, runId: job.id } }
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
      finishedAt: requireFinishedAt({
        actionId: job.actionId,
        runId: job.id,
        finishedAt: finalRun.finishedAt,
      }),
      record: finalRun,
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed"
    const finishedAt = new Date()
    const writebackFailure =
      status === "failed" && activeRun?.writeback?.status === "failed"
        ? activeRun.writeback.error
        : undefined
    const failure =
      writebackFailure ??
      toActionRunFailure(
        error,
        status === "cancelled" ? "cancelled" : (activeRun?.phase ?? "validation"),
        {
          actionId: job.actionId,
          runId: job.id,
          at: finishedAt,
        }
      )

    const finishedRun = await runtime.actionRunsStorage
      .finish({
        projectId: runtime.id,
        id: job.id,
        status,
        finishedAt,
        error: failure,
      })
      .catch(() => null)

    if (!finishedRun) {
      throw error
    }
    if (status === "failed" && finishedRun.status === "failed") {
      reportActionFailure(input, error, failure)
    }

    const startedAt = startedRun?.startedAt ?? finishedRun.startedAt ?? finishedRun.queuedAt
    return {
      id: job.id,
      actionId: job.actionId,
      subject: finishedRun.subject,
      status,
      startedAt,
      finishedAt: requireFinishedAt({
        actionId: job.actionId,
        runId: job.id,
        finishedAt: finishedRun.finishedAt,
      }),
      error: failure,
      record: finishedRun,
    }
  }
}

function reportActionFailure(
  input: RunActionJobInput,
  error: unknown,
  failure: ActionRunFailure
): void {
  reportRunFailure(input.runtime.errorReporterHost, error, {
    projectId: input.runtime.id,
    attempt: input.attempt,
    runKind: "action",
    run: {
      runId: input.job.id,
      actionId: input.job.actionId,
    },
    failure,
  })
}
