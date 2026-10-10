import type { ActionSubject } from "../../actions"
import { stableJsonStringify } from "../../json"
import type { ActionRunEffectsRecord, ActionRunRecord, ActionRunWritebackRecord } from "./types"

export function actionSubjectsEqual(left: ActionSubject, right: ActionSubject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "none") return true
  if (right.kind === "none") return false
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}

export function actionRunParamsEqual(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

/** Whether two runs carry the same request: the same Action, subject, and params. */
export function actionRunRequestsEqual(
  left: Pick<ActionRunRecord, "actionId" | "subject" | "params">,
  right: Pick<ActionRunRecord, "actionId" | "subject" | "params">
): boolean {
  return (
    left.actionId === right.actionId &&
    actionSubjectsEqual(left.subject, right.subject) &&
    actionRunParamsEqual(left.params, right.params)
  )
}

export type ActionRunPhaseRecord = ActionRunWritebackRecord | ActionRunEffectsRecord

export function actionRunPhaseRecordsEqual(
  left: ActionRunPhaseRecord,
  right: ActionRunPhaseRecord
): boolean {
  return actionRunParamsEqual(stripPhaseRecordCompletedAt(left), stripPhaseRecordCompletedAt(right))
}

function stripPhaseRecordCompletedAt(
  record: ActionRunPhaseRecord
): Omit<ActionRunPhaseRecord, "completedAt"> {
  const { completedAt: _completedAt, ...stableRecord } = record
  return stableRecord
}
