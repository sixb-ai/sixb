import type { Database } from "bun:sqlite"
import type {
  FinishSyncRunInput,
  JsonValue,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  StartSyncRunInput,
  SyncRunFailure,
  SyncRunRecord,
  SyncRunStorage,
} from "@sixb/core"
import { SyncRunError } from "@sixb/core"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteSyncRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteSyncRunStorage implements SyncRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteSyncRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async start(input: StartSyncRunInput): Promise<SyncRunRecord> {
    const startedAt = input.startedAt ?? new Date()

    try {
      this.db
        .query(
          `
          INSERT INTO sync_runs (
            project_id,
            id,
            sync_id,
            dataset_id,
            mode,
            status,
            started_at,
            expected_latest_version_id,
            commit_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.syncId,
          input.datasetId,
          input.mode,
          "running",
          startedAt.toISOString(),
          input.expectedLatestVersionId ?? null,
          input.commitMessage ?? null
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SyncRunError(
          `[SixbSqlite] Sync run '${input.id}' already exists for project '${input.projectId}'.`
        )
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

      if (input.status === "succeeded" && input.output.datasetId !== existing.dataset_id) {
        throw new SyncRunError(
          `[SixbSqlite] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
        )
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
            error_name = ?,
            error_message = ?,
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
          input.status === "succeeded" ? input.output.versionId : null,
          input.status === "succeeded" ? null : (input.error?.name ?? null),
          input.status === "succeeded" ? null : (input.error?.message ?? null),
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
    if (input.statuses && input.statuses.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: (string | number)[] = [input.projectId]

    if (input.syncId) {
      whereClauses.push("sync_id = ?")
      args.push(input.syncId)
    }

    if (input.datasetId) {
      whereClauses.push("dataset_id = ?")
      args.push(input.datasetId)
    }

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    if (input.startedAfter) {
      whereClauses.push("started_at >= ?")
      args.push(input.startedAfter.toISOString())
    }

    if (input.startedBefore) {
      whereClauses.push("started_at <= ?")
      args.push(input.startedBefore.toISOString())
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const limit = input.limit

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM sync_runs ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT * FROM sync_runs
      ${where}
      ORDER BY started_at ${order}, id ${order}
    `
    const queryArgs = [...args]

    if (limit !== undefined) {
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as DatabaseRow[]
    const runs = rows.map(rowToSyncRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < totalRow.count,
      total: totalRow.count,
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

function toSyncRunFailure(row: DatabaseRow): SyncRunFailure | undefined {
  if (!row.error_message) {
    return undefined
  }

  return {
    name: row.error_name ?? undefined,
    message: row.error_message,
  }
}

function rowToSyncRunRecord(row: DatabaseRow): SyncRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    syncId: row.sync_id,
    datasetId: row.dataset_id,
    mode: row.mode,
    status: row.status,
    startedAt: new Date(row.started_at),
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
    error: toSyncRunFailure(row),
    checkpoint: parseCheckpoint(row.checkpoint),
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

interface DatabaseRow {
  project_id: string
  id: string
  sync_id: string
  dataset_id: string
  mode: SyncRunRecord["mode"]
  status: SyncRunRecord["status"]
  started_at: string
  finished_at: string | null
  rows_read: number | null
  output_version_id: string | null
  expected_latest_version_id: string | null
  commit_message: string | null
  error_name: string | null
  error_message: string | null
  checkpoint: string | null
}
