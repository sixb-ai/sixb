import type { ActionSubject } from "../../actions"
import { stableJsonStringify } from "../../json"
import type {
  ActionRunEffectsRecord,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunWritebackRecord,
  FinishActionRunInput,
  QueueActionRunInput,
} from "./types"

export function actionSubjectsEqual(left: ActionSubject, right: ActionSubject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "none") return true
  if (right.kind === "none") return false
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}

export function actionRunParamsEqual(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

export type ActionRunPhaseRecord = ActionRunWritebackRecord | ActionRunEffectsRecord

export function actionRunPhaseRecordsEqual(
  left: ActionRunPhaseRecord,
  right: ActionRunPhaseRecord
): boolean {
  return actionRunParamsEqual(stripPhaseRecordCompletedAt(left), stripPhaseRecordCompletedAt(right))
}

export function finishActionRunPhase(
  input: FinishActionRunInput,
  current: ActionRunPhase | null | undefined
): ActionRunPhase {
  if (input.status === "succeeded") {
    return input.phase ?? current ?? "validation"
  }

  return input.phase ?? input.error?.phase ?? current ?? "validation"
}

export function canRequeueActionRunAfterEnqueueFailure(
  existing: ActionRunRecord,
  input: QueueActionRunInput
): boolean {
  return (
    existing.status === "failed" &&
    existing.phase === "enqueue" &&
    existing.actionId === input.actionId &&
    existing.idempotencyKey === input.idempotencyKey &&
    actionSubjectsEqual(existing.subject, input.subject) &&
    actionRunParamsEqual(existing.params, input.params)
  )
}

export function isTerminalActionRun(record: Pick<ActionRunRecord, "status">): boolean {
  return (
    record.status === "succeeded" || record.status === "failed" || record.status === "cancelled"
  )
}

function stripPhaseRecordCompletedAt(
  record: ActionRunPhaseRecord
): Omit<ActionRunPhaseRecord, "completedAt"> {
  const { completedAt: _completedAt, ...stableRecord } = record
  return stableRecord
}
