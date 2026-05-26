import { cloneJsonValue, type JsonValue } from "../../json"
import { SyncRunError } from "./errors"
import type {
  FinishSyncRunInput,
  ListSyncRunsInput,
  ListSyncRunsResult,
  StartSyncRunInput,
  SyncRunFailure,
  SyncRunRecord,
  SyncRunStorage,
} from "./types"

function syncRunKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function cloneSyncRunRecord(record: SyncRunRecord): SyncRunRecord {
  return structuredClone(record)
}

function normalizeCheckpoint(checkpoint: JsonValue | undefined): JsonValue | undefined {
  return checkpoint !== undefined ? cloneJsonValue(checkpoint) : undefined
}

function normalizeError(error: SyncRunFailure | undefined): SyncRunFailure | undefined {
  return error ? structuredClone(error) : undefined
}

function compareRuns(a: SyncRunRecord, b: SyncRunRecord, order: "asc" | "desc"): number {
  const delta = a.startedAt.getTime() - b.startedAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  if (a.id === b.id) {
    return 0
  }

  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

export class InMemorySyncRunStorage implements SyncRunStorage {
  private readonly rows = new Map<string, SyncRunRecord>()

  async start(input: StartSyncRunInput): Promise<SyncRunRecord> {
    const key = syncRunKey(input.projectId, input.id)
    if (this.rows.has(key)) {
      throw new SyncRunError(
        `[Pario] Sync run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: SyncRunRecord = {
      id: input.id,
      projectId: input.projectId,
      syncId: input.syncId,
      datasetId: input.datasetId,
      mode: input.mode,
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      expectedLatestVersionId: input.expectedLatestVersionId,
      commitMessage: input.commitMessage,
    }

    this.rows.set(key, structuredClone(record))
    return cloneSyncRunRecord(record)
  }

  async finish(input: FinishSyncRunInput): Promise<SyncRunRecord> {
    const key = syncRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)

    if (!existing) {
      throw new SyncRunError(
        `[Pario] Sync run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    if (input.status === "succeeded" && input.output.datasetId !== existing.datasetId) {
      throw new SyncRunError(
        `[Pario] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.datasetId}'.`
      )
    }

    const base: SyncRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
    }

    const next: SyncRunRecord =
      input.status === "succeeded"
        ? {
            ...base,
            rowsRead: input.rowsRead,
            output: structuredClone(input.output),
            error: undefined,
            checkpoint: normalizeCheckpoint(input.checkpoint),
          }
        : {
            ...base,
            rowsRead: input.rowsRead ?? existing.rowsRead,
            output: undefined,
            error: normalizeError(input.error),
            checkpoint: undefined,
          }

    this.rows.set(key, structuredClone(next))
    return cloneSyncRunRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null> {
    const record = this.rows.get(syncRunKey(params.projectId, params.id))
    return record ? cloneSyncRunRecord(record) : null
  }

  async list(input: ListSyncRunsInput): Promise<ListSyncRunsResult> {
    const order = input.order ?? "desc"
    const offset = input.offset ?? 0
    const limit = input.limit ?? this.rows.size
    const statuses = input.statuses ? new Set(input.statuses) : null

    const filtered = [...this.rows.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.syncId ? record.syncId === input.syncId : true))
      .filter((record) => (input.datasetId ? record.datasetId === input.datasetId : true))
      .filter((record) => (statuses ? statuses.has(record.status) : true))
      .filter((record) => (input.startedAfter ? record.startedAt >= input.startedAfter : true))
      .filter((record) => (input.startedBefore ? record.startedAt <= input.startedBefore : true))
      .sort((a, b) => compareRuns(a, b, order))

    const total = filtered.length
    const runs = filtered.slice(offset, offset + limit).map(cloneSyncRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }
}
