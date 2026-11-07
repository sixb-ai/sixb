import type { LakeRetentionRunRecord, LakeRetentionRunStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

export class PgLakeRetentionRunStorage implements LakeRetentionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async record(run: LakeRetentionRunRecord): Promise<void> {
    await this.sql`
      INSERT INTO lake_retention_runs (project_id, started_at, finished_at, failed)
      VALUES (${run.projectId}, ${run.startedAt}, ${run.finishedAt}, ${run.failed})
      ON CONFLICT (project_id) DO UPDATE SET
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        failed = EXCLUDED.failed
    `
  }

  async getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null> {
    const [row] = await this.sql<PgLakeRetentionRunRow[]>`
      SELECT project_id, started_at, finished_at, failed
      FROM lake_retention_runs
      WHERE project_id = ${input.projectId}
    `
    if (!row) return null

    return {
      projectId: row.project_id,
      startedAt: new Date(row.started_at),
      finishedAt: row.finished_at ? new Date(row.finished_at) : null,
      failed: row.failed,
    }
  }
}

interface PgLakeRetentionRunRow {
  readonly project_id: string
  readonly started_at: Date
  readonly finished_at: Date | null
  readonly failed: boolean
}
