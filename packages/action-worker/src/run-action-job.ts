import type { ActionRunFailure, ActionRunRecord, ActionTargetObject } from "@sixb/core"
import { isObjectActionDefinition, isTerminalActionRun, ObjectNotFoundError } from "@sixb/core"
import { ActionWorkerError } from "./errors"
import { throwIfAborted, toActionRunFailure } from "./normalize"
import type { ActionRunResult, RunActionJobInput } from "./types"

function toActionTargetObject(
  row: {
    primaryId: string
    objectTypeId: string
    properties: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
  },
  declaredObjectTypeId: string
): ActionTargetObject {
  return {
    primaryId: row.primaryId,
    objectTypeId: declaredObjectTypeId,
    properties: row.properties,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function requireFinishedAt(runId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw new ActionWorkerError(`Action run '${runId}' finished without a finishedAt timestamp.`)
}

export async function runActionJob(input: RunActionJobInput): Promise<ActionRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal

  throwIfAborted(signal)

  const existingRun = await runtime.actionRunsStorage.getById({
    projectId: runtime.id,
    id: job.id,
  })
  if (!existingRun) {
    throw new ActionWorkerError(`Action run '${job.id}' was not found.`)
  }
  if (existingRun.actionId !== job.actionId) {
    throw new ActionWorkerError(
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
  if (existingRun.status === "running") {
    return failRedeliveredRunningRun(input, existingRun)
  }
  if (existingRun.status !== "queued") {
    throw new ActionWorkerError(
      `Action run '${job.id}' cannot execute from status '${existingRun.status}'.`
    )
  }

  const action = runtime.getActionById(job.actionId)
  if (!action) {
    const failure = toActionRunFailure(
      new ActionWorkerError(`Unknown action '${job.actionId}'.`),
      "validation"
    )
    const finishedRun = await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: job.id,
      status: "failed",
      error: failure,
    })

    return {
      id: job.id,
      actionId: job.actionId,
      subject: finishedRun.subject,
      status: "failed",
      startedAt: finishedRun.startedAt ?? finishedRun.queuedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      error: failure,
      record: finishedRun,
    }
  }

  let startedRun: ActionRunRecord | null = null
  let activeRun: ActionRunRecord | null = null
  try {
    startedRun = await runtime.actionRunsStorage.start({
      projectId: runtime.id,
      id: job.id,
    })
    activeRun = startedRun
    throwIfAborted(signal)

    if (!isObjectActionDefinition(action)) {
      if (startedRun.subject.kind !== "none") {
        throw new ActionWorkerError(`Action '${job.actionId}' does not accept a subject.`)
      }

      activeRun = await runtime.actionRunsStorage.enterPhase({
        projectId: runtime.id,
        id: job.id,
        phase: "legacy_handler",
      })
      await action.handler({
        params: startedRun.params,
        sixb: runtime.sixb,
        signal,
      })
    } else {
      if (startedRun.subject.kind !== "object") {
        throw new ActionWorkerError(`Action '${job.actionId}' requires an object subject.`)
      }

      const subjectObjectType = runtime.sixb.getObjectTypeById(startedRun.subject.objectTypeId)
      if (!subjectObjectType) {
        throw new ActionWorkerError(
          `Unknown object type '${startedRun.subject.objectTypeId}' for action '${job.actionId}'.`
        )
      }

      const actionAppliesToSubject = runtime.sixb
        .getActionsForType(subjectObjectType)
        .some((candidate) => candidate.id === action.id)
      if (!actionAppliesToSubject) {
        throw new ActionWorkerError(
          `Action '${job.actionId}' is not valid for object type '${subjectObjectType.id}'.`
        )
      }

      const targetRow = await runtime.storage.objects.getByPrimaryId({
        projectId: runtime.id,
        objectTypeId: subjectObjectType.id,
        primaryId: startedRun.subject.primaryId,
      })

      if (!targetRow) {
        throw new ObjectNotFoundError(
          startedRun.subject.objectTypeId,
          startedRun.subject.primaryId,
          "Object not found for action run"
        )
      }

      activeRun = await runtime.actionRunsStorage.enterPhase({
        projectId: runtime.id,
        id: job.id,
        phase: "legacy_handler",
      })
      await action.handler({
        params: startedRun.params,
        target: toActionTargetObject(targetRow, action.target.id),
        sixb: runtime.sixb,
        signal,
      })
    }

    throwIfAborted(signal)

    const finishedRun = await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: job.id,
      status: "succeeded",
    })

    return {
      id: job.id,
      actionId: job.actionId,
      subject: startedRun.subject,
      status: "succeeded",
      startedAt: startedRun.startedAt ?? startedRun.queuedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      record: finishedRun,
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

async function failRedeliveredRunningRun(
  input: RunActionJobInput,
  existingRun: ActionRunRecord
): Promise<ActionRunResult> {
  const { runtime, job } = input
  const error = new ActionWorkerError(
    `Action run '${job.id}' was redelivered while already running. The previous worker may have lost its queue lease or crashed.`
  )
  const failure: ActionRunFailure = {
    name: "ActionRunLeaseLostError",
    message: error.message,
    phase: existingRun.phase ?? "legacy_handler",
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
