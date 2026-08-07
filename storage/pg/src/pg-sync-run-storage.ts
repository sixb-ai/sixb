import type { JsonValue } from "@sixb/core"
import type {
  FinishSyncRunInput,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  StartSyncRunInput,
  SyncRunFailure,
  SyncRunRecord,
  SyncRunStorage,
} from "@sixb/core/storage"
import { SyncRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SqlParameter } from "./pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
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

      if (input.status === "succeeded") {
        if (input.output && input.output.datasetId !== existing.dataset_id) {
          throw new SyncRunError(
            `[SixbPg] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${existing.dataset_id}'.`
          )
        }
        if (!input.output && input.rowsRead !== 0 && existing.mode !== "merge") {
          throw new SyncRunError(
            `[SixbPg] Sync run '${input.id}' may omit its output with rows read only for an initial merge no-op.`
          )
        }
      }

      const [updated] =
        input.status === "succeeded"
          ? await tx<DatabaseRow[]>`
              UPDATE sync_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                rows_read = ${input.rowsRead},
                output_version_id = ${input.output?.versionId ?? null},
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
    if (hasEmptyStatuses(input) || input.syncIds?.length === 0) {
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

    if (input.syncIds) {
      const placeholders = input.syncIds.map(() => `$${index++}`)
      whereClauses.push(`sync_id IN (${placeholders.join(", ")})`)
      params.push(...input.syncIds)
    }

    if (input.datasetId) {
      whereClauses.push(`dataset_id = $${index++}`)
      params.push(input.datasetId)
    }

    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<DatabaseRow>({
      sql: this.sql,
      tableName: "sync_runs",
      selectList: "*, checkpoint IS NOT NULL AS checkpoint_present",
      whereClauses,
      params,
      nextIndex: index,
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
