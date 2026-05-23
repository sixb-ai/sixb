import type { ActionRunRecord, ActionTargetObject } from "@sixb/core"
import { ActionRunError, isObjectActionDefinition, ObjectNotFoundError } from "@sixb/core"
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

  throw new Error(
    `[SixbActionWorker] Action run '${runId}' finished without a finishedAt timestamp.`
  )
}

function isDuplicateStartError(error: unknown): boolean {
  return error instanceof ActionRunError && /already exists/i.test(error.message)
}

export async function runActionJob(input: RunActionJobInput): Promise<ActionRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const action = runtime.getActionById(job.actionId)

  if (!action) {
    throw new Error(`[SixbActionWorker] Unknown action '${job.actionId}'.`)
  }

  throwIfAborted(signal)

  let startedRun: ActionRunRecord
  try {
    startedRun = await runtime.actionRunsStorage.start({
      projectId: runtime.id,
      id: job.id,
      actionId: job.actionId,
      subject: job.subject,
      params: job.params,
    })
  } catch (error) {
    const existing = await runtime.actionRunsStorage.getById({
      projectId: runtime.id,
      id: job.id,
    })
    if (existing && isDuplicateStartError(error)) {
      return {
        id: job.id,
        actionId: job.actionId,
        subject: job.subject,
        status: existing.status,
        skipped: true,
        record: existing,
      }
    }

    throw error
  }

  try {
    throwIfAborted(signal)

    if (!isObjectActionDefinition(action)) {
      if (job.subject.kind !== "none") {
        throw new Error(`[SixbActionWorker] Action '${job.actionId}' does not accept a subject.`)
      }

      await action.handler({
        params: job.params,
        sixb: runtime.sixb,
        signal,
      })
    } else {
      if (job.subject.kind !== "object") {
        throw new Error(`[SixbActionWorker] Action '${job.actionId}' requires an object subject.`)
      }

      const subjectObjectType = runtime.sixb.getObjectTypeById(job.subject.objectTypeId)
      if (!subjectObjectType) {
        throw new Error(
          `[SixbActionWorker] Unknown object type '${job.subject.objectTypeId}' for action '${job.actionId}'.`
        )
      }

      const actionAppliesToSubject = runtime.sixb
        .getActionsForType(subjectObjectType)
        .some((candidate) => candidate.id === action.id)
      if (!actionAppliesToSubject) {
        throw new Error(
          `[SixbActionWorker] Action '${job.actionId}' is not valid for object type '${subjectObjectType.id}'.`
        )
      }

      const targetRow = await runtime.storage.objects.getByPrimaryId({
        projectId: runtime.id,
        objectTypeId: subjectObjectType.id,
        primaryId: job.subject.primaryId,
      })

      if (!targetRow) {
        throw new ObjectNotFoundError(
          job.subject.objectTypeId,
          job.subject.primaryId,
          "Object not found for action run"
        )
      }

      await action.handler({
        params: job.params,
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
      subject: job.subject,
      status: "succeeded",
      startedAt: startedRun.startedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      record: finishedRun,
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed"
    const failure = toActionRunFailure(error, status === "cancelled" ? "cancelled" : "handler")

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

    return {
      id: job.id,
      actionId: job.actionId,
      subject: job.subject,
      status,
      startedAt: startedRun.startedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      error: failure,
      record: finishedRun,
    }
  }
}
