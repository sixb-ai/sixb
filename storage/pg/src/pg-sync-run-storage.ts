import type { JsonValue } from "@sixb/core"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import {
  canFinishSyncRun,
  canRequeueSyncRunAfterEnqueueFailure,
  mayFinishRun,
} from "@sixb/core/internal/storage"
import { assertSyncRunExecution } from "@sixb/core/internal/sync-run-storage-provider"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ExecutionStorage,
  FinishSyncRunInput,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListLostRunsInput,
  ListSyncRunsInput,
  ListSyncRunsResult,
  PrepareSyncRunCommitInput,
  QueueSyncRunInput,
  ReleaseRunExecutionInput,
  RunClaim,
  SyncRunRecord,
  SyncRunStorage,
} from "@sixb/core/storage"
import { SYNC_RUN_FAILURE_CODES, SyncRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SqlParameter } from "./pg-client"
import {
  claimPgRun,
  confirmPgRunExecution,
  listLostPgRuns,
  lockHeldPgRun,
  lockPgRun,
  type PgRunExecutionColumns,
  type PgRunTable,
  pgRunExecutionFields,
  releasePgRun,
} from "./run-claim-sql"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

const SYNC_RUNS: PgRunTable<DatabaseRow, SyncRunRecord> = {
  name: "sync_runs",
  returning: "*, checkpoint IS NOT NULL AS checkpoint_present",
  toRun: rowToSyncRunRecord,
  notFound: (projectId, id) =>
    new SyncRunError(`[SixbPg] Sync run '${id}' not found for project '${projectId}'.`),
  staleExecution,
}

export class PgSyncRunStorage implements SyncRunStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

  async queue(input: QueueSyncRunInput): Promise<SyncRunRecord> {
    await assertSyncRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      syncId: input.syncId,
    })
    try {
      const [row] = await this.sql<DatabaseRow[]>`
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
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.executionId},
          ${input.syncId},
          ${input.datasetId},
          ${input.mode},
          ${"queued"},
          ${input.queuedAt ?? new Date()},
          ${null},
          ${input.expectedLatestVersionId ?? null},
          ${input.commitMessage ?? null}
        )
        RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
      `

      return rowToSyncRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.requeueAfterEnqueueFailure(input)
      }

      throw error
    }
  }

  private async requeueAfterEnqueueFailure(input: QueueSyncRunInput): Promise<SyncRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<DatabaseRow[]>`
        SELECT *, checkpoint IS NOT NULL AS checkpoint_present FROM sync_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!existing || !canRequeueSyncRunAfterEnqueueFailure(rowToSyncRunRecord(existing), input)) {
        throw new SyncRunError(
          `[SixbPg] Sync run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE sync_runs
        SET status = ${"queued"}, queued_at = ${input.queuedAt ?? new Date()},
            attempt = ${0}, execution_token = ${null}, execution_queue_lease_expires_at = ${null},
            commit_prepared_at = ${null}, started_at = ${null}, finished_at = ${null},
            rows_read = ${null},
            output_version_id = ${null}, error = ${null}, checkpoint = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
      `
      return rowToSyncRunRecord(updated)
    })
  }

  async startOrReclaim(input: ClaimRunInput): Promise<RunClaim<SyncRunRecord>> {
    return runPgTransaction(this.sql, async (tx) => {
      const { syncId } = await lockPgRun(tx, SYNC_RUNS, input.projectId, input.id)

      // Two queued runs of one Sync would each see the other not running yet.
      await lockAdvisoryKeys(tx, [syncRunsLockKey(input.projectId, syncId)])

      const [sibling] = await tx<DatabaseRow[]>`
        SELECT *, checkpoint IS NOT NULL AS checkpoint_present FROM sync_runs
        WHERE project_id = ${input.projectId} AND sync_id = ${syncId}
          AND status = ${"running"} AND id <> ${input.id}
        LIMIT 1
      `
      return claimPgRun(tx, SYNC_RUNS, input, sibling && rowToSyncRunRecord(sibling))
    })
  }

  async confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<SyncRunRecord> {
    return runPgTransaction(this.sql, (tx) => confirmPgRunExecution(tx, SYNC_RUNS, input))
  }

  async listLost(input: ListLostRunsInput): Promise<readonly SyncRunRecord[]> {
    return listLostPgRuns(this.sql, SYNC_RUNS, input)
  }

  async releaseExecution(input: ReleaseRunExecutionInput): Promise<void> {
    await releasePgRun(this.sql, SYNC_RUNS, input)
  }

  async prepareCommit(input: PrepareSyncRunCommitInput): Promise<SyncRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await lockHeldPgRun(tx, SYNC_RUNS, input)

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE sync_runs
        SET rows_read = ${input.rowsRead},
            checkpoint = ${serializeCheckpoint(input.checkpoint)}::text::jsonb,
            commit_prepared_at = ${input.preparedAt ?? new Date()}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
      `
      return rowToSyncRunRecord(updated)
    })
  }

  async finish(input: FinishSyncRunInput): Promise<SyncRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const record = await lockPgRun(tx, SYNC_RUNS, input.projectId, input.id)

      if (!canFinishSyncRun(record.status, input)) {
        throw new SyncRunError(
          `[SixbPg] Sync run '${input.id}' cannot finish from status '${record.status}'.`
        )
      }

      if (!mayFinishRun(record, input)) throw staleExecution(input.id)

      if (input.status === "succeeded") {
        if (input.output && input.output.datasetId !== record.datasetId) {
          throw new SyncRunError(
            `[SixbPg] Sync run '${input.id}' output dataset '${input.output.datasetId}' does not match '${record.datasetId}'.`
          )
        }
        if (!input.output && input.rowsRead !== 0 && record.mode !== "merge") {
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
                execution_token = ${null},
                execution_queue_lease_expires_at = ${null},
                finished_at = ${input.finishedAt ?? new Date()},
                rows_read = ${input.rowsRead},
                output_version_id = ${input.output?.versionId ?? null},
                error = ${null},
                checkpoint = ${serializeCheckpoint(input.checkpoint)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *, checkpoint IS NOT NULL AS checkpoint_present
            `
          : await tx<DatabaseRow[]>`
              UPDATE sync_runs
              SET
                status = ${input.status},
                execution_token = ${null},
                execution_queue_lease_expires_at = ${null},
                finished_at = ${input.finishedAt ?? new Date()},
                rows_read = ${input.rowsRead ?? record.rowsRead ?? null},
                output_version_id = ${null},
                error = ${input.error === undefined ? null : serializeSixbFailure(input.error, SYNC_RUN_FAILURE_CODES)}::text::jsonb,
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

    index = appendRunListFilters(
      whereClauses,
      params,
      index,
      input,
      "COALESCE(started_at, queued_at)"
    )

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

function staleExecution(id: string): SyncRunError {
  return new SyncRunError(`[SixbPg] Execution token is no longer current on sync run '${id}'.`)
}

function syncRunsLockKey(projectId: string, syncId: string): string {
  return `sync-runs:${JSON.stringify([projectId, syncId])}`
}

function serializeCheckpoint(checkpoint: JsonValue | undefined): string | null {
  return checkpoint !== undefined ? JSON.stringify(checkpoint) : null
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
    ...pgRunExecutionFields(row),
    commitPreparedAt: row.commit_prepared_at ? new Date(row.commit_prepared_at) : undefined,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
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
    error: row.error === null ? undefined : parseSixbFailure(row.error, SYNC_RUN_FAILURE_CODES),
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

interface DatabaseRow extends PgRunExecutionColumns {
  project_id: string
  id: string
  execution_id: string
  sync_id: string
  dataset_id: string
  mode: SyncRunRecord["mode"]
  status: SyncRunRecord["status"]
  commit_prepared_at: Date | string | null
  queued_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  rows_read: number | string | null
  output_version_id: string | null
  expected_latest_version_id: string | null
  commit_message: string | null
  error: JsonValue | null
  checkpoint: JsonValue | null
  checkpoint_present: boolean | number | string
}
