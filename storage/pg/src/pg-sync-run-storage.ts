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
import type { SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgSyncRunStorage implements SyncRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async start(input: StartSyncRunInput): Promise<SyncRunRecord> {
    try {
      const [row] = await this.sql<DatabaseRow[]>`
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
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.syncId},
          ${input.datasetId},
          ${input.mode},
          ${"running"},
          ${input.startedAt ?? new Date()},
          ${input.expectedLatestVersionId ?? null},
          ${input.commitMessage ?? null}
        )
        RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
      `

      return rowToSyncRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SyncRunError(
          `[SixbPg] Sync run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async finish(input: FinishSyncRunInput): Promise<SyncRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<DatabaseRow[]>`
        SELECT *, checkpoint IS NOT NULL AS checkpoint_present FROM sync_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `

      if (!existing) {
        throw new SyncRunError(
          `[SixbPg] Sync run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (input.status === "succeeded" && input.output.datasetId !== existing.dataset_id) {
        throw new SyncRunError(
          `[SixbPg] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? await tx<DatabaseRow[]>`
              UPDATE sync_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                rows_read = ${input.rowsRead},
                output_version_id = ${input.output.versionId},
                error_name = ${null},
                error_message = ${null},
                checkpoint = ${serializeCheckpoint(input.checkpoint)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
            `
          : await tx<DatabaseRow[]>`
              UPDATE sync_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                rows_read = ${input.rowsRead ?? existing.rows_read ?? null},
                output_version_id = ${null},
                error_name = ${input.error?.name ?? null},
                error_message = ${input.error?.message ?? null},
                checkpoint = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
            `

      return rowToSyncRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null> {
    const [row] = await this.sql<DatabaseRow[]>`
      SELECT *, checkpoint IS NOT NULL AS checkpoint_present FROM sync_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

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

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.syncId) {
      whereClauses.push(`sync_id = $${index++}`)
      params.push(input.syncId)
    }

    if (input.datasetId) {
      whereClauses.push(`dataset_id = $${index++}`)
      params.push(input.datasetId)
    }

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.startedAfter) {
      whereClauses.push(`started_at >= $${index++}`)
      params.push(input.startedAfter)
    }

    if (input.startedBefore) {
      whereClauses.push(`started_at <= $${index++}`)
      params.push(input.startedBefore)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0

    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM sync_runs ${where}`,
      params
    )

    const queryParams = [...params]
    let query = `
      SELECT *, checkpoint IS NOT NULL AS checkpoint_present FROM sync_runs
      ${where}
      ORDER BY started_at ${order}, id ${order}
    `

    if (input.limit !== undefined) {
      query += ` LIMIT $${index++} OFFSET $${index++}`
      queryParams.push(input.limit, offset)
    } else if (offset > 0) {
      query += ` OFFSET $${index++}`
      queryParams.push(offset)
    }

    const rows = await this.sql.unsafe<DatabaseRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)
    const runs = rows.map(rowToSyncRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }

  async listLatestBySyncIds(input: ListLatestSyncRunsInput): Promise<ListLatestSyncRunsResult> {
    const rows = await queryLatestRunsByOwnerId<DatabaseRow>({
      sql: this.sql,
      tableName: "sync_runs",
      ownerColumn: "sync_id",
      ownerIds: input.syncIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.sync_id,
      selectList: "*, checkpoint IS NOT NULL AS checkpoint_present",
    })

    return {
      runs: rows.map(rowToSyncRunRecord),
    }
  }
}

function serializeCheckpoint(checkpoint: JsonValue | undefined): string | null {
  return checkpoint !== undefined ? JSON.stringify(checkpoint) : null
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
    rowsRead: row.rows_read != null ? Number(row.rows_read) : undefined,
    output: row.output_version_id
      ? {
          datasetId: row.dataset_id,
          versionId: row.output_version_id,
        }
      : undefined,
    expectedLatestVersionId: row.expected_latest_version_id ?? undefined,
    commitMessage: row.commit_message ?? undefined,
    error: toSyncRunFailure(row),
    checkpoint: hasCheckpoint(row) ? row.checkpoint : undefined,
  }
}

function hasCheckpoint(row: DatabaseRow): boolean {
  return (
    row.checkpoint_present === true ||
    row.checkpoint_present === 1 ||
    row.checkpoint_present === "1" ||
    row.checkpoint_present === "t" ||
    row.checkpoint_present === "true"
  )
}

interface DatabaseRow {
  project_id: string
  id: string
  sync_id: string
  dataset_id: string
  mode: SyncRunRecord["mode"]
  status: SyncRunRecord["status"]
  started_at: Date | string
  finished_at: Date | string | null
  rows_read: number | string | null
  output_version_id: string | null
  expected_latest_version_id: string | null
  commit_message: string | null
  error_name: string | null
  error_message: string | null
  checkpoint: JsonValue | null
  checkpoint_present: boolean | number | string
}
