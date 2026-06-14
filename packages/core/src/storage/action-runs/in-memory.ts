import { ActionRunError } from "./errors"
import type {
  ActionRunFailure,
  ActionRunParams,
  ActionRunRecord,
  ActionRunStorage,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  StartActionRunInput,
} from "./types"

function actionRunKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function cloneActionRunRecord(record: ActionRunRecord): ActionRunRecord {
  return structuredClone(record)
}

function normalizeParams(params: ActionRunParams): ActionRunParams {
  return structuredClone(params)
}

function normalizeSubject(subject: QueueActionRunInput["subject"]): QueueActionRunInput["subject"] {
  return structuredClone(subject)
}

function normalizeError(error: ActionRunFailure | undefined): ActionRunFailure | undefined {
  return error ? structuredClone(error) : undefined
}

function compareRuns(a: ActionRunRecord, b: ActionRunRecord, order: "asc" | "desc"): number {
  const leftAt = a.startedAt ?? a.queuedAt
  const rightAt = b.startedAt ?? b.queuedAt
  const delta = leftAt.getTime() - rightAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  if (a.id === b.id) {
    return 0
  }

  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

export class InMemoryActionRunStorage implements ActionRunStorage {
  private readonly rows = new Map<string, ActionRunRecord>()

  async queue(input: QueueActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)
    if (existing && !canRequeueAfterEnqueueFailure(existing, input)) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: ActionRunRecord = {
      id: input.id,
      projectId: input.projectId,
      actionId: input.actionId,
      subject: normalizeSubject(input.subject),
      status: "queued",
      phase: "request",
      queuedAt: new Date(input.queuedAt ?? new Date()),
      params: normalizeParams(input.params),
      idempotencyKey: input.idempotencyKey,
      securityContext: input.securityContext ? structuredClone(input.securityContext) : undefined,
    }

    if (existing) {
      const next: ActionRunRecord = {
        ...existing,
        status: "queued",
        phase: "request",
        queuedAt: record.queuedAt,
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        securityContext: record.securityContext,
      }
      this.rows.set(key, structuredClone(next))
      return cloneActionRunRecord(next)
    }

    this.rows.set(key, structuredClone(record))
    return cloneActionRunRecord(record)
  }

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)

    if (!existing) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    if (existing.status !== "queued") {
      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' cannot start from status '${existing.status}'.`
      )
    }

    const next: ActionRunRecord = {
      ...existing,
      status: "running",
      phase: "handler",
      startedAt: new Date(input.startedAt ?? new Date()),
      error: undefined,
    }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)

    if (!existing) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const phase =
      input.status === "succeeded"
        ? (input.phase ?? existing.phase)
        : (input.phase ?? input.error?.phase ?? existing.phase)

    const base: ActionRunRecord = {
      ...existing,
      status: input.status,
      phase,
      finishedAt: new Date(input.finishedAt ?? new Date()),
    }

    const next: ActionRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            error: undefined,
          }
        : {
            ...base,
            error: normalizeError(input.error),
          }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null> {
    const record = this.rows.get(actionRunKey(params.projectId, params.id))
    return record ? cloneActionRunRecord(record) : null
  }

  async list(input: ListActionRunsInput): Promise<ListActionRunsResult> {
    const order = input.order ?? "desc"
    const offset = input.offset ?? 0
    const limit = input.limit ?? this.rows.size
    const statuses = input.statuses ? new Set(input.statuses) : null

    const filtered = [...this.rows.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.actionId ? record.actionId === input.actionId : true))
      .filter((record) => (input.subject ? subjectsEqual(record.subject, input.subject) : true))
      .filter((record) =>
        input.objectTypeId
          ? record.subject.kind === "object" && record.subject.objectTypeId === input.objectTypeId
          : true
      )
      .filter((record) =>
        input.primaryId
          ? record.subject.kind === "object" && record.subject.primaryId === input.primaryId
          : true
      )
      .filter((record) => (statuses ? statuses.has(record.status) : true))
      .filter((record) =>
        input.startedAfter ? (record.startedAt ?? record.queuedAt) >= input.startedAfter : true
      )
      .filter((record) =>
        input.startedBefore ? (record.startedAt ?? record.queuedAt) <= input.startedBefore : true
      )
      .sort((a, b) => compareRuns(a, b, order))

    const total = filtered.length
    const runs = filtered.slice(offset, offset + limit).map(cloneActionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }
}

function subjectsEqual(
  left: QueueActionRunInput["subject"],
  right: QueueActionRunInput["subject"]
): boolean {
  if (left.kind !== right.kind) {
    return false
  }

  if (left.kind === "none") {
    return true
  }

  if (right.kind === "none") {
    return false
  }

  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}

function canRequeueAfterEnqueueFailure(
  existing: ActionRunRecord,
  input: QueueActionRunInput
): boolean {
  return (
    existing.status === "failed" &&
    existing.phase === "enqueue" &&
    existing.actionId === input.actionId &&
    existing.idempotencyKey === input.idempotencyKey &&
    subjectsEqual(existing.subject, input.subject) &&
    stableJsonStringify(existing.params) === stableJsonStringify(input.params)
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`
}
