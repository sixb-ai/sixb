import type { LakeRetentionRunRecord, LakeRetentionRunStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

export class PgLakeRetentionRunStorage implements LakeRetentionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async record(run: LakeRetentionRunRecord): Promise<void> {
    await this.sql`
      INSERT INTO lake_retention_runs (project_id, finished_at, failed)
      VALUES (${run.projectId}, ${run.finishedAt}, ${run.failed})
      ON CONFLICT (project_id) DO UPDATE SET
        finished_at = EXCLUDED.finished_at,
        failed = EXCLUDED.failed
    `
  }

  async getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null> {
    const [row] = await this.sql<PgLakeRetentionRunRow[]>`
      SELECT project_id, finished_at, failed
      FROM lake_retention_runs
      WHERE project_id = ${input.projectId}
    `
    if (!row) return null

    return {
      projectId: row.project_id,
      finishedAt: new Date(row.finished_at),
      failed: row.failed,
    }
  }
}

interface PgLakeRetentionRunRow {
  readonly project_id: string
  readonly finished_at: Date
  readonly failed: boolean
}
