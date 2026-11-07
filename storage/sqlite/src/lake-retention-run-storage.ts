import type { Database } from "bun:sqlite"
import type { LakeRetentionRunRecord, LakeRetentionRunStorage } from "@sixb/core/storage"
import type { SqliteStoreConnection } from "./transactions"

export class SqliteLakeRetentionRunStorage implements LakeRetentionRunStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async record(run: LakeRetentionRunRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO lake_retention_runs (project_id, started_at, finished_at, failed)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           failed = excluded.failed`
      )
      .run(
        run.projectId,
        run.startedAt.toISOString(),
        run.finishedAt?.toISOString() ?? null,
        run.failed ? 1 : 0
      )
  }

  async getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null> {
    const row = this.db
      .query<SqliteLakeRetentionRunRow, [string]>(
        `SELECT project_id, started_at, finished_at, failed
         FROM lake_retention_runs
         WHERE project_id = ?`
      )
      .get(input.projectId)
    if (!row) return null

    return {
      projectId: row.project_id,
      startedAt: new Date(row.started_at),
      finishedAt: row.finished_at ? new Date(row.finished_at) : null,
      failed: row.failed === 1,
    }
  }
}

interface SqliteLakeRetentionRunRow {
  readonly project_id: string
  readonly started_at: string
  readonly finished_at: string | null
  readonly failed: number
}
