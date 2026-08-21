import type { Database } from "bun:sqlite"
import type { JsonValue } from "@sixb/core"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import { assertSyncRunExecution } from "@sixb/core/internal/sync-run-storage-provider"
import type {
  ExecutionStorage,
  FinishSyncRunInput,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  QueueSyncRunInput,
  StartSyncRunInput,
  SyncRunRecord,
  SyncRunStorage,
} from "@sixb/core/storage"
import {
  canRequeueSyncRunAfterEnqueueFailure,
  SYNC_RUN_FAILURE_CODES,
  SyncRunError,
} from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  appendRunListFilters,
  hasEmptyStatuses,
  queryRunList,
  type SqliteValue,
} from "./run-list-query"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteSyncRunStorageOptions {
  /** Execution lookup sharing the same provider transaction. */
  executions: ExecutionStorage
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteSyncRunStorage implements SyncRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database
  private readonly executions: ExecutionStorage

  constructor(options: SqliteSyncRunStorageOptions) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    this.executions = options.executions

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async queue(input: QueueSyncRunInput): Promise<SyncRunRecord> {
    const queuedAt = input.queuedAt ?? new Date()
    await assertSyncRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      syncId: input.syncId,
    })

    try {
      this.db
        .query(
          `
          INSERT INTO sync_runs (
            project_id,
            id,
            execution_id,
            sync_id,
            dataset_id,
            mode,
            status,
            queued_at,
            started_at,
            expected_latest_version_id,
            commit_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.executionId,
          input.syncId,
          input.datasetId,
          input.mode,
          "queued",
          queuedAt.toISOString(),
          input.expectedLatestVersionId ?? null,
          input.commitMessage ?? null
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return this.requeueAfterEnqueueFailure(input, queuedAt)
      }

      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new SyncRunError(
        `[SixbSqlite] Failed to load sync run '${input.id}' for project '${input.projectId}'.`
      )
    }

    return record
  }

  private async requeueAfterEnqueueFailure(
    input: QueueSyncRunInput,
    queuedAt: Date
  ): Promise<SyncRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM sync_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null
      if (!existing || !canRequeueSyncRunAfterEnqueueFailure(rowToSyncRunRecord(existing), input)) {
        throw new SyncRunError(
          `[SixbSqlite] Sync run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE sync_runs
          SET status = ?, queued_at = ?, started_at = NULL, finished_at = NULL,
              rows_read = NULL, output_version_id = NULL, error = NULL, checkpoint = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run("queued", queuedAt.toISOString(), input.projectId, input.id)

      const updated = this.db
        .query("SELECT * FROM sync_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow
      return rowToSyncRunRecord(updated)
    })()
  }

  async start(input: StartSyncRunInput): Promise<SyncRunRecord> {
    const result = this.db
      .query(
        `
        UPDATE sync_runs
        SET status = ?, started_at = ?, error = NULL
        WHERE project_id = ? AND id = ? AND status = ?
      `
      )
      .run(
        "running",
        (input.startedAt ?? new Date()).toISOString(),
        input.projectId,
        input.id,
        "queued"
      )
    if (result.changes > 0) {
      const record = await this.getById({ projectId: input.projectId, id: input.id })
      if (record) return record
    }

    const existing = await this.getById({ projectId: input.projectId, id: input.id })
    if (!existing) {
      throw new SyncRunError(
        `[SixbSqlite] Sync run '${input.id}' not found for project '${input.projectId}'.`
      )
    }
    throw new SyncRunError(
      `[SixbSqlite] Sync run '${input.id}' cannot start from status '${existing.status}'.`
    )
  }

  async finish(input: FinishSyncRunInput): Promise<SyncRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM sync_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null

      if (!existing) {
        throw new SyncRunError(
          `[SixbSqlite] Sync run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const enqueueFailure =
        input.status === "failed" && input.error.code === "queue.enqueue_failed"
      if (
        (enqueueFailure && existing.status !== "queued") ||
        (!enqueueFailure && existing.status !== "running")
      ) {
        throw new SyncRunError(
          `[SixbSqlite] Sync run '${input.id}' cannot finish from status '${existing.status}'.`
        )
      }

      if (input.status === "succeeded") {
        if (input.output && input.output.datasetId !== existing.dataset_id) {
          throw new SyncRunError(
            `[SixbSqlite] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
          )
        }
        if (!input.output && input.rowsRead !== 0 && existing.mode !== "merge") {
          throw new SyncRunError(
            `[SixbSqlite] Sync run '${input.id}' may omit its output with rows read only for an initial merge no-op.`
          )
        }
      }

      this.db
        .query(
          `
          UPDATE sync_runs
          SET
            status = ?,
            finished_at = ?,
            rows_read = ?,
            output_version_id = ?,
            error = ?,
            checkpoint = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded"
            ? input.rowsRead
            : (input.rowsRead ?? existing.rows_read ?? null),
          input.status === "succeeded" ? (input.output?.versionId ?? null) : null,
          input.status === "succeeded" || input.error === undefined
            ? null
            : serializeSixbFailure(input.error, SYNC_RUN_FAILURE_CODES),
          input.status === "succeeded" ? serializeCheckpoint(input.checkpoint) : null,
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM sync_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToSyncRunRecord(updated)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM sync_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as DatabaseRow | null

    return row ? rowToSyncRunRecord(row) : null
  }

  async list(input: ListSyncRunsInput): Promise<ListSyncRunsResult> {
    if (hasEmptyStatuses(input) || input.syncIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.syncId) {
      whereClauses.push("sync_id = ?")
      args.push(input.syncId)
    }

    if (input.syncIds) {
      whereClauses.push(`sync_id IN (${input.syncIds.map(() => "?").join(", ")})`)
      args.push(...input.syncIds)
    }

    if (input.datasetId) {
      whereClauses.push("dataset_id = ?")
      args.push(input.datasetId)
    }

    appendRunListFilters(whereClauses, args, input, "COALESCE(started_at, queued_at)")

    const { rows, total, hasMore } = queryRunList<DatabaseRow>({
      db: this.db,
      tableName: "sync_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return {
      runs: rows.map(rowToSyncRunRecord),
      hasMore,
      total,
    }
  }

  async listLatestBySyncIds(input: ListLatestSyncRunsInput): Promise<ListLatestSyncRunsResult> {
    const rows = queryLatestRunsByOwnerId<DatabaseRow>({
      db: this.db,
      tableName: "sync_runs",
      ownerColumn: "sync_id",
      ownerIds: input.syncIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.sync_id,
    })

    return {
      runs: rows.map(rowToSyncRunRecord),
    }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}

function serializeCheckpoint(checkpoint: JsonValue | undefined): string | null {
  return checkpoint !== undefined ? JSON.stringify(checkpoint) : null
}

function parseCheckpoint(value: string | null | undefined): JsonValue | undefined {
  return value != null ? (JSON.parse(value) as JsonValue) : undefined
}

function rowToSyncRunRecord(row: DatabaseRow): SyncRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    syncId: row.sync_id,
    datasetId: row.dataset_id,
    mode: row.mode,
    status: row.status,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    rowsRead: row.rows_read ?? undefined,
    output: row.output_version_id
      ? {
          datasetId: row.dataset_id,
          versionId: row.output_version_id,
        }
      : undefined,
    expectedLatestVersionId: row.expected_latest_version_id ?? undefined,
    commitMessage: row.commit_message ?? undefined,
    error: row.error === null ? undefined : parseSixbFailure(row.error, SYNC_RUN_FAILURE_CODES),
    checkpoint: parseCheckpoint(row.checkpoint),
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

interface DatabaseRow {
  project_id: string
  id: string
  execution_id: string
  sync_id: string
  dataset_id: string
  mode: SyncRunRecord["mode"]
  status: SyncRunRecord["status"]
  queued_at: string
  started_at: string | null
  finished_at: string | null
  rows_read: number | null
  output_version_id: string | null
  expected_latest_version_id: string | null
  commit_message: string | null
  error: string | null
  checkpoint: string | null
}
