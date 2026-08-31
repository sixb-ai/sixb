import { parseSixbFailure } from "../../errors/internal"
import type { SixbFailure } from "../../errors/types"
import { cloneJsonValue, type JsonValue } from "../../json"
import type { ExecutionStorage } from "../executions"
import {
  compareStartedAt,
  hasEmptyStatuses,
  latestStartedAtByOwnerId,
  matchesRunListDateFilters,
  paginate,
  toStatusSet,
} from "../run-listing"
import { SyncRunError } from "./errors"
import { canRequeueSyncRunAfterEnqueueFailure } from "./idempotency"
import { assertSyncRunExecution } from "./provider"
import type {
  FinishSyncRunInput,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  QueueSyncRunInput,
  StartSyncRunInput,
  SyncRunFailureCode,
  SyncRunRecord,
  SyncRunStorage,
} from "./types"
import { SYNC_RUN_FAILURE_CODES } from "./types"

function syncRunKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function cloneSyncRunRecord(record: SyncRunRecord): SyncRunRecord {
  return structuredClone(record)
}

function normalizeCheckpoint(checkpoint: JsonValue | undefined): JsonValue | undefined {
  return checkpoint !== undefined ? cloneJsonValue(checkpoint) : undefined
}

function normalizeError(
  error: SixbFailure<SyncRunFailureCode> | undefined
): SixbFailure<SyncRunFailureCode> | undefined {
  return error ? parseSixbFailure(error, SYNC_RUN_FAILURE_CODES) : undefined
}

export class InMemorySyncRunStorage implements SyncRunStorage {
  private readonly rows = new Map<string, SyncRunRecord>()

  constructor(private readonly executions: ExecutionStorage) {}

  snapshot(): InMemorySyncRunStorageSnapshot {
    return structuredClone(this.rows)
  }

  restore(snapshot: InMemorySyncRunStorageSnapshot): void {
    this.rows.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.rows.set(key, record)
    }
  }

  async queue(input: QueueSyncRunInput): Promise<SyncRunRecord> {
    const key = syncRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)
    if (existing && !canRequeueSyncRunAfterEnqueueFailure(existing, input)) {
      throw new SyncRunError(
        `[Sixb] Sync run '${input.id}' already exists for project '${input.projectId}'.`
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
      throw new SyncRunError(
        `[Sixb] Execution '${input.executionId}' already belongs to another Sync run.`
      )
    }
    await assertSyncRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      syncId: input.syncId,
    })

    const queuedAt = new Date(input.queuedAt ?? new Date())
    if (existing) {
      const next: SyncRunRecord = {
        ...existing,
        status: "queued",
        queuedAt,
        startedAt: undefined,
        finishedAt: undefined,
        rowsRead: undefined,
        output: undefined,
        error: undefined,
        checkpoint: undefined,
      }
      this.rows.set(key, structuredClone(next))
      return cloneSyncRunRecord(next)
    }

    const record: SyncRunRecord = {
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      syncId: input.syncId,
      datasetId: input.datasetId,
      mode: input.mode,
      status: "queued",
      queuedAt,
      expectedLatestVersionId: input.expectedLatestVersionId,
      commitMessage: input.commitMessage,
    }

    this.rows.set(key, structuredClone(record))
    return cloneSyncRunRecord(record)
  }

  async start(input: StartSyncRunInput): Promise<SyncRunRecord> {
    const key = syncRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)
    if (!existing) {
      throw new SyncRunError(
        `[Sixb] Sync run '${input.id}' not found for project '${input.projectId}'.`
      )
    }
    if (existing.status !== "queued") {
      throw new SyncRunError(
        `[Sixb] Sync run '${input.id}' cannot start from status '${existing.status}'.`
      )
    }

    const next: SyncRunRecord = {
      ...existing,
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      error: undefined,
    }
    this.rows.set(key, structuredClone(next))
    return cloneSyncRunRecord(next)
  }

  async finish(input: FinishSyncRunInput): Promise<SyncRunRecord> {
    const key = syncRunKey(input.projectId, input.id)
    const existing = this.rows.get(key)

    if (!existing) {
      throw new SyncRunError(
        `[Sixb] Sync run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const enqueueFailure = input.status === "failed" && input.error.code === "queue.enqueue_failed"
    if (
      (enqueueFailure && existing.status !== "queued") ||
      (!enqueueFailure && existing.status !== "running")
    ) {
      throw new SyncRunError(
        `[Sixb] Sync run '${input.id}' cannot finish from status '${existing.status}'.`
      )
    }

    if (input.status === "succeeded") {
      if (input.output && input.output.datasetId !== existing.datasetId) {
        throw new SyncRunError(
          `[Sixb] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.datasetId}'.`
        )
      }
      if (!input.output && input.rowsRead !== 0 && existing.mode !== "merge") {
        throw new SyncRunError(
          `[Sixb] Sync run '${input.id}' may omit its output with rows read only for an initial merge no-op.`
        )
      }
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
            output: input.output ? structuredClone(input.output) : undefined,
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
    if (hasEmptyStatuses(input) || input.syncIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const syncIds = input.syncIds ? new Set(input.syncIds) : null

    const filtered = [...this.rows.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.syncId ? record.syncId === input.syncId : true))
      .filter((record) => (syncIds ? syncIds.has(record.syncId) : true))
      .filter((record) => (input.datasetId ? record.datasetId === input.datasetId : true))
      .filter((record) =>
        matchesRunListDateFilters(record, {
          statuses,
          startedAfter: input.startedAfter,
          startedBefore: input.startedBefore,
        })
      )
      .sort((left, right) => compareStartedAt(left, right, order))

    const { page, total, hasMore } = paginate(filtered, input)

    return {
      runs: page.map(cloneSyncRunRecord),
      hasMore,
      total,
    }
  }

  async listLatestBySyncIds(input: ListLatestSyncRunsInput): Promise<ListLatestSyncRunsResult> {
    const runs = latestStartedAtByOwnerId(
      [...this.rows.values()].filter((record) => record.projectId === input.projectId),
      input.syncIds,
      (record) => record.syncId
    )

    return {
      runs: runs.map(cloneSyncRunRecord),
    }
  }
}

export type InMemorySyncRunStorageSnapshot = Map<string, SyncRunRecord>
