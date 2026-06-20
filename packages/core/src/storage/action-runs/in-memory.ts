import { ActionRunError } from "./errors"
import {
  actionRunCommitDiffsEqual,
  actionRunPhaseRecordsEqual,
  actionSubjectsEqual,
  canRequeueActionRunAfterEnqueueFailure,
  isTerminalActionRun,
  normalizeActionRunCommitDiff,
} from "./idempotency"
import type {
  ActionRunCommitRecord,
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunParams,
  ActionRunRecord,
  ActionRunStorage,
  ActionRunWritebackRecord,
  EnterActionRunPhaseInput,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  RecordActionCommitInput,
  RecordActionEffectsInput,
  RecordActionWritebackInput,
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

function normalizeWriteback(
  input: RecordActionWritebackInput,
  completedAt: Date
): ActionRunWritebackRecord {
  if (input.status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
      result: structuredClone(input.result),
    }
  }

  return {
    status: "failed",
    completedAt,
    error: normalizeError(input.error),
  }
}

function normalizeCommit(input: RecordActionCommitInput, committedAt: Date): ActionRunCommitRecord {
  return {
    committedAt,
    diff: normalizeActionRunCommitDiff(input.diff),
  }
}

function normalizeEffects(
  input: RecordActionEffectsInput,
  completedAt: Date
): ActionRunEffectsRecord {
  if (input.status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
    }
  }

  return {
    status: "failed",
    completedAt,
    error: normalizeError(input.error),
  }
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

  snapshot(): InMemoryActionRunStorageSnapshot {
    return structuredClone(this.rows)
  }

  restore(snapshot: InMemoryActionRunStorageSnapshot): void {
    this.rows.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.rows.set(key, record)
    }
  }

  async queue(input: QueueActionRunInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)
    if (existing && !canRequeueActionRunAfterEnqueueFailure(existing, input)) {
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
        writeback: undefined,
        commit: undefined,
        effects: undefined,
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
      phase: input.phase ?? "validation",
      startedAt: new Date(input.startedAt ?? new Date()),
      error: undefined,
    }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.requireRunningRun(key, input.projectId, input.id, "enter phase")
    const next: ActionRunRecord = {
      ...existing,
      phase: input.phase,
    }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.requireRunningRun(key, input.projectId, input.id, "record writeback")
    const writeback = normalizeWriteback(input, new Date(input.completedAt ?? new Date()))

    if (existing.writeback) {
      if (actionRunPhaseRecordsEqual(existing.writeback, writeback)) {
        return cloneActionRunRecord(existing)
      }

      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' already has a different writeback record.`
      )
    }

    const next: ActionRunRecord = {
      ...existing,
      phase: "writeback",
      writeback,
    }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async recordCommit(input: RecordActionCommitInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.requireRunningRun(key, input.projectId, input.id, "record commit")
    const commit = normalizeCommit(input, new Date(input.committedAt ?? new Date()))

    if (existing.commit) {
      if (actionRunCommitDiffsEqual(existing.commit.diff, commit.diff)) {
        return cloneActionRunRecord(existing)
      }

      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' already has a different commit diff.`
      )
    }

    const next: ActionRunRecord = {
      ...existing,
      phase: "commit",
      commit,
    }

    this.rows.set(key, structuredClone(next))
    return cloneActionRunRecord(next)
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    const key = actionRunKey(input.projectId, input.id)
    const existing = this.requireRunningRun(key, input.projectId, input.id, "record effects")
    const effects = normalizeEffects(input, new Date(input.completedAt ?? new Date()))

    if (existing.effects) {
      if (actionRunPhaseRecordsEqual(existing.effects, effects)) {
        return cloneActionRunRecord(existing)
      }

      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' already has a different effects record.`
      )
    }

    const next: ActionRunRecord = {
      ...existing,
      phase: "effects",
      effects,
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

    if (isTerminalActionRun(existing)) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.id}' cannot finish from terminal status '${existing.status}'.`
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

  private requireRunningRun(
    key: string,
    projectId: string,
    id: string,
    operation: string
  ): ActionRunRecord {
    const existing = this.rows.get(key)

    if (!existing) {
      throw new ActionRunError(`[Sixb] Action run '${id}' not found for project '${projectId}'.`)
    }

    if (existing.status !== "running") {
      throw new ActionRunError(
        `[Sixb] Action run '${id}' cannot ${operation} from status '${existing.status}'.`
      )
    }

    return existing
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
      .filter((record) =>
        input.subject ? actionSubjectsEqual(record.subject, input.subject) : true
      )
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

export type InMemoryActionRunStorageSnapshot = Map<string, ActionRunRecord>
