import type { ExecutionStorage } from "../executions"
import { ActionRunError } from "./errors"
import { actionSubjectsEqual } from "./idempotency"
import { assertActionRunExecution } from "./provider"
import { normalizeRecordActionRunInput, resolveActionRunEffects } from "./record"
import type {
  ActionRunRecord,
  ActionRunStorage,
  ListActionRunsInput,
  ListActionRunsResult,
  RecordActionEffectsInput,
  RecordActionRunInput,
} from "./types"

type RunRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

const runDirectly: RunRootOperation = async <T>(run: () => Promise<T> | T): Promise<T> => run()

function actionRunKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function cloneActionRunRecord(record: ActionRunRecord): ActionRunRecord {
  return structuredClone(record)
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

  async record(input: RecordActionRunInput): Promise<ActionRunRecord> {
    return this.runRootOperation(async () => {
      const record = normalizeRecordActionRunInput(input)
      const key = actionRunKey(record.projectId, record.id)
      if (this.rows.has(key)) {
        throw new ActionRunError(
          `[Sixb] Action run '${record.id}' is already recorded for project '${record.projectId}'.`
        )
      }
      if (
        [...this.rows.values()].some(
          (run) => run.projectId === record.projectId && run.executionId === record.executionId
        )
      ) {
        throw new ActionRunError(
          `[Sixb] Execution '${record.executionId}' already belongs to another Action run.`
        )
      }
      await assertActionRunExecution({
        executions: this.executions,
        projectId: record.projectId,
        executionId: record.executionId,
        runId: record.id,
        actionId: record.actionId,
      })

      this.rows.set(key, structuredClone(record))
      return cloneActionRunRecord(record)
    })
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return this.runRootOperation(() => {
      const key = actionRunKey(input.projectId, input.id)
      const { run, effects } = resolveActionRunEffects(this.rows.get(key) ?? null, input)
      if (!effects) return cloneActionRunRecord(run)

      const next: ActionRunRecord = { ...run, phase: "effects", effects }
      this.rows.set(key, structuredClone(next))
      return cloneActionRunRecord(next)
    })
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
        .filter((record) => (input.startedAfter ? record.startedAt >= input.startedAfter : true))
        .filter((record) => (input.startedBefore ? record.startedAt <= input.startedBefore : true))
        .sort((a, b) => compareRuns(a, b, order))

      const total = filtered.length
      const runs = filtered.slice(offset, offset + limit).map(cloneActionRunRecord)
      return { runs, hasMore: offset + runs.length < total, total }
    })
  }
}

export type InMemoryActionRunStorageSnapshot = Map<string, ActionRunRecord>
