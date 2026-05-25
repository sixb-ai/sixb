import type { JsonValue } from "../../json"
import { ActionRunError } from "./errors"
import type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  StartActionRunInput,
} from "./types"

function actionRunKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function cloneActionRunRecord(record: ActionRunRecord): ActionRunRecord {
  return structuredClone(record)
}

function normalizeParams(
  params: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return structuredClone(params)
}

function normalizeSubject(subject: StartActionRunInput["subject"]): StartActionRunInput["subject"] {
  return structuredClone(subject)
}

function normalizeMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined
): Readonly<Record<string, JsonValue>> | undefined {
  return metadata ? structuredClone(metadata) : undefined
}

function normalizeError(error: ActionRunFailure | undefined): ActionRunFailure | undefined {
  return error ? structuredClone(error) : undefined
}

function compareRuns(a: ActionRunRecord, b: ActionRunRecord, order: "asc" | "desc"): number {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
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

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    if (this.rows.has(key)) {
      throw new ActionRunError(
        `[Pario] Action run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: ActionRunRecord = {
      id: input.id,
      projectId: input.projectId,
      actionId: input.actionId,
      subject: normalizeSubject(input.subject),
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      params: normalizeParams(input.params),
      metadata: normalizeMetadata(input.metadata),
    }

    this.rows.set(key, structuredClone(record))
    return cloneActionRunRecord(record)
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)

    if (!existing) {
      throw new ActionRunError(
        `[Pario] Action run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const metadata =
      existing.metadata || input.metadata
        ? {
            ...(existing.metadata ?? {}),
            ...(normalizeMetadata(input.metadata) ?? {}),
          }
        : undefined

    const base: ActionRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      metadata,
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
      .filter((record) => (input.startedAfter ? record.startedAt >= input.startedAfter : true))
      .filter((record) => (input.startedBefore ? record.startedAt <= input.startedBefore : true))
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
  left: StartActionRunInput["subject"],
  right: StartActionRunInput["subject"]
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
