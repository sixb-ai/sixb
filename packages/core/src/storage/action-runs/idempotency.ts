import type { ActionSubject } from "../../actions"
import type { ActionRunCommitDiff, ActionRunRecord, QueueActionRunInput } from "./types"

export function actionSubjectsEqual(left: ActionSubject, right: ActionSubject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "none") return true
  if (right.kind === "none") return false
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}

export function actionRunParamsEqual(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

export function actionRunCommitDiffsEqual(
  left: ActionRunCommitDiff,
  right: ActionRunCommitDiff
): boolean {
  return (
    stableJsonStringify(normalizeActionRunCommitDiff(left)) ===
    stableJsonStringify(normalizeActionRunCommitDiff(right))
  )
}

export function normalizeActionRunCommitDiff(diff: ActionRunCommitDiff): ActionRunCommitDiff {
  return {
    objects: [...diff.objects]
      .map((entry) => ({
        objectTypeId: entry.objectTypeId,
        primaryId: entry.primaryId,
        operation: entry.operation,
        changedProperties: [...new Set(entry.changedProperties)].sort(compareStrings),
      }))
      .sort(
        (left, right) =>
          compareStrings(left.objectTypeId, right.objectTypeId) ||
          compareStrings(left.primaryId, right.primaryId) ||
          compareStrings(left.operation, right.operation)
      ),
    links: [...diff.links]
      .map((entry) => ({
        operation: entry.operation,
        source: {
          objectTypeId: entry.source.objectTypeId,
          primaryId: entry.source.primaryId,
        },
        linkId: entry.linkId,
        target: {
          objectTypeId: entry.target.objectTypeId,
          primaryId: entry.target.primaryId,
        },
      }))
      .sort(
        (left, right) =>
          compareStrings(left.source.objectTypeId, right.source.objectTypeId) ||
          compareStrings(left.source.primaryId, right.source.primaryId) ||
          compareStrings(left.linkId, right.linkId) ||
          compareStrings(left.target.objectTypeId, right.target.objectTypeId) ||
          compareStrings(left.target.primaryId, right.target.primaryId) ||
          compareStrings(left.operation, right.operation)
      ),
  }
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

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
