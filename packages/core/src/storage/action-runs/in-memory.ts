import type { ExecutionStorage } from "../executions"
import { ActionRunError } from "./errors"
import { parseActionRunFailure } from "./failure"
import {
  actionRunPhaseRecordsEqual,
  actionSubjectsEqual,
  canRequeueActionRunAfterEnqueueFailure,
  isTerminalActionRun,
} from "./idempotency"
import { assertActionRunExecution } from "./provider"
import type {
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunStorage,
  ActionRunWritebackRecord,
  EnterActionRunPhaseInput,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  LockActionMaterializationRunInput,
  QueueActionRunInput,
  RecordActionEffectsInput,
  RecordActionWritebackInput,
  StartActionRunInput,
} from "./types"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function actionRunKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function assertNonBlank(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ActionRunError(`[Sixb] Action materialization ${fieldName} must be nonblank.`)
  }
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

function normalizeError<TPhase extends ActionRunPhase>(
  error: ActionRunFailure<TPhase>,
  expectedPhase?: TPhase
): ActionRunFailure<TPhase> {
  return expectedPhase === undefined
    ? (parseActionRunFailure(error) as ActionRunFailure<TPhase>)
    : parseActionRunFailure(error, expectedPhase)
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
    error: normalizeError(input.error, "writeback"),
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
    error: normalizeError(input.error, "effects"),
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
  private readonly runRootOperation: RunRootOperation

  constructor(
    private readonly executions: ExecutionStorage,
    input: { readonly runRootOperation?: RunRootOperation } = {}
  ) {
    this.runRootOperation = input.runRootOperation ?? runDirectly
  }

  snapshot(): InMemoryActionRunStorageSnapshot {
    return structuredClone(this.rows)
  }

  restore(snapshot: InMemoryActionRunStorageSnapshot): void {
    this.rows.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.rows.set(key, record)
    }
  }

  async lockForMaterialization(input: LockActionMaterializationRunInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => cloneActionRunRecord(this.requireMaterializationRun(input)))
  }

  async queue(input: QueueActionRunInput): Promise<ActionRunRecord> {
    return this.runRootOperation(async () => {
      const key = actionRunKey(input.projectId, input.id)
      const existing = this.rows.get(key)
      if (existing && !canRequeueActionRunAfterEnqueueFailure(existing, input)) {
        throw new ActionRunError(
          `[Sixb] Action run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      if (
        [...this.rows.values()].some(
          (run) =>
            run.projectId === input.projectId &&
            run.id !== input.id &&
            run.executionId === input.executionId
        )
      ) {
        throw new ActionRunError(
          `[Sixb] Execution '${input.executionId}' already belongs to another Action run.`
        )
      }
      await assertActionRunExecution({
        executions: this.executions,
        projectId: input.projectId,
        executionId: input.executionId,
        runId: input.id,
        actionId: input.actionId,
      })

      const record: ActionRunRecord = {
        id: input.id,
        projectId: input.projectId,
        executionId: input.executionId,
        actionId: input.actionId,
        subject: normalizeSubject(input.subject),
        status: "queued",
        phase: "request",
        queuedAt: new Date(input.queuedAt ?? new Date()),
        params: normalizeParams(input.params),
        idempotencyKey: input.idempotencyKey,
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
          effects: undefined,
        }
        this.rows.set(key, structuredClone(next))
        return cloneActionRunRecord(next)
      }

      this.rows.set(key, structuredClone(record))
      return cloneActionRunRecord(record)
    })
  }

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
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
    })
  }

  async enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
      const key = actionRunKey(input.projectId, input.id)
      const existing = this.requireRunningRun(key, input.projectId, input.id, "enter phase")
      const next: ActionRunRecord = {
        ...existing,
        phase: input.phase,
      }

      this.rows.set(key, structuredClone(next))
      return cloneActionRunRecord(next)
    })
  }

  async recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
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
    })
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
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
    })
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
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
        input.status === "succeeded" ? (input.phase ?? existing.phase) : input.error.details.phase

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
    })
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
    return this.runRootOperation(() => {
      const record = this.rows.get(actionRunKey(params.projectId, params.id))
      return record ? cloneActionRunRecord(record) : null
    })
  }

  async list(input: ListActionRunsInput): Promise<ListActionRunsResult> {
    return this.runRootOperation(() => {
      if (input.actionIds?.length === 0) {
        return { runs: [], hasMore: false, total: 0 }
      }

      const order = input.order ?? "desc"
      const offset = input.offset ?? 0
      const limit = input.limit ?? this.rows.size
      const actionIds = input.actionIds ? new Set(input.actionIds) : null
      const objectTypeIds = input.objectTypeIds ? new Set(input.objectTypeIds) : null
      const statuses = input.statuses ? new Set(input.statuses) : null

      const filtered = [...this.rows.values()]
        .filter((record) => record.projectId === input.projectId)
        .filter((record) => (input.actionId ? record.actionId === input.actionId : true))
        .filter((record) => (actionIds ? actionIds.has(record.actionId) : true))
        .filter((record) =>
          objectTypeIds
            ? record.subject.kind !== "object" || objectTypeIds.has(record.subject.objectTypeId)
            : true
        )
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
      return { runs, hasMore: offset + runs.length < total, total }
    })
  }

  private requireMaterializationRun(input: LockActionMaterializationRunInput): ActionRunRecord {
    assertNonBlank(input.projectId, "projectId")
    assertNonBlank(input.runId, "runId")
    assertNonBlank(input.actionId, "actionId")

    const existing = this.rows.get(actionRunKey(input.projectId, input.runId))
    if (!existing) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.runId}' not found for project '${input.projectId}'.`
      )
    }
    if (existing.actionId !== input.actionId) {
      throw new ActionRunError(
        `[Sixb] Action run '${input.runId}' does not belong to action '${input.actionId}'.`
      )
    }
    if (existing.status !== "running") {
      throw new ActionRunError(
        `[Sixb] Action run '${input.runId}' cannot materialize from status '${existing.status}'.`
      )
    }
    return existing
  }
}

export type InMemoryActionRunStorageSnapshot = Map<string, ActionRunRecord>
