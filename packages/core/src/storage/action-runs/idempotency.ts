import type { ActionSubject } from "../../actions"
import { ActionRunError } from "./errors"
import type {
  ActionRunCommitDiff,
  ActionRunCommitRecord,
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
  assertUniqueActionRunCommitDiff(diff)

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

export interface ActionRunCommitSourceRow {
  readonly runId: string
  readonly committedAt: Date | string
}

export interface ActionRunObjectDiffSourceRow {
  readonly runId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly operation: ActionRunCommitDiff["objects"][number]["operation"]
}

export interface ActionRunObjectDiffPropertySourceRow {
  readonly runId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly propertyId: string
}

export interface ActionRunLinkDiffSourceRow {
  readonly runId: string
  readonly operation: ActionRunCommitDiff["links"][number]["operation"]
  readonly sourceObjectTypeId: string
  readonly sourcePrimaryId: string
  readonly linkId: string
  readonly targetObjectTypeId: string
  readonly targetPrimaryId: string
}

export function buildActionRunCommitRecords(
  commitRows: readonly ActionRunCommitSourceRow[],
  objectRows: readonly ActionRunObjectDiffSourceRow[],
  propertyRows: readonly ActionRunObjectDiffPropertySourceRow[],
  linkRows: readonly ActionRunLinkDiffSourceRow[]
): Map<string, ActionRunCommitRecord> {
  const propertiesByObject = new Map<string, string[]>()
  for (const propertyRow of propertyRows) {
    const key = commitObjectDiffKey(propertyRow)
    const properties = propertiesByObject.get(key) ?? []
    properties.push(propertyRow.propertyId)
    propertiesByObject.set(key, properties)
  }

  const objectsByRun = new Map<string, ActionRunCommitDiff["objects"][number][]>()
  for (const objectRow of objectRows) {
    const objects = objectsByRun.get(objectRow.runId) ?? []
    objects.push({
      objectTypeId: objectRow.objectTypeId,
      primaryId: objectRow.primaryId,
      operation: objectRow.operation,
      changedProperties: propertiesByObject.get(commitObjectDiffKey(objectRow)) ?? [],
    })
    objectsByRun.set(objectRow.runId, objects)
  }

  const linksByRun = new Map<string, ActionRunCommitDiff["links"][number][]>()
  for (const linkRow of linkRows) {
    const links = linksByRun.get(linkRow.runId) ?? []
    links.push({
      operation: linkRow.operation,
      source: {
        objectTypeId: linkRow.sourceObjectTypeId,
        primaryId: linkRow.sourcePrimaryId,
      },
      linkId: linkRow.linkId,
      target: {
        objectTypeId: linkRow.targetObjectTypeId,
        primaryId: linkRow.targetPrimaryId,
      },
    })
    linksByRun.set(linkRow.runId, links)
  }

  const commits = new Map<string, ActionRunCommitRecord>()
  for (const commitRow of commitRows) {
    commits.set(commitRow.runId, {
      committedAt: new Date(commitRow.committedAt),
      diff: normalizeActionRunCommitDiff({
        objects: objectsByRun.get(commitRow.runId) ?? [],
        links: linksByRun.get(commitRow.runId) ?? [],
      }),
    })
  }

  return commits
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

function assertUniqueActionRunCommitDiff(diff: ActionRunCommitDiff): void {
  const objectKeys = new Set<string>()
  for (const objectDiff of diff.objects) {
    const key = `${objectDiff.objectTypeId}:${objectDiff.primaryId}`
    if (objectKeys.has(key)) {
      throw new ActionRunError(`[Sixb] Action commit diff contains duplicate object edit '${key}'.`)
    }
    objectKeys.add(key)
  }

  const linkKeys = new Set<string>()
  for (const linkDiff of diff.links) {
    const key = [
      linkDiff.operation,
      linkDiff.source.objectTypeId,
      linkDiff.source.primaryId,
      linkDiff.linkId,
      linkDiff.target.objectTypeId,
      linkDiff.target.primaryId,
    ].join(":")

    if (linkKeys.has(key)) {
      throw new ActionRunError(`[Sixb] Action commit diff contains duplicate link edit '${key}'.`)
    }
    linkKeys.add(key)
  }
}

function stripPhaseRecordCompletedAt(
  record: ActionRunPhaseRecord
): Omit<ActionRunPhaseRecord, "completedAt"> {
  const { completedAt: _completedAt, ...stableRecord } = record
  return stableRecord
}

function commitObjectDiffKey(row: {
  readonly runId: string
  readonly objectTypeId: string
  readonly primaryId: string
}): string {
  return `${row.runId}:${row.objectTypeId}:${row.primaryId}`
}
