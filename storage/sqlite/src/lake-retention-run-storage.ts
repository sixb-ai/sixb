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
        `INSERT INTO lake_retention_runs (project_id, finished_at, failed)
         VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           finished_at = excluded.finished_at,
           failed = excluded.failed`
      )
      .run(run.projectId, run.finishedAt.toISOString(), run.failed ? 1 : 0)
  }

  async getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null> {
    const row = this.db
      .query<SqliteLakeRetentionRunRow, [string]>(
        `SELECT project_id, finished_at, failed FROM lake_retention_runs WHERE project_id = ?`
      )
      .get(input.projectId)
    if (!row) return null

    return {
      projectId: row.project_id,
      finishedAt: new Date(row.finished_at),
      failed: row.failed === 1,
    }
  }
}

interface SqliteLakeRetentionRunRow {
  readonly project_id: string
  readonly finished_at: string
  readonly failed: number
}
