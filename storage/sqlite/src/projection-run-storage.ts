import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { serializeSixbFailure } from "@sixb/core/internal/errors"
import {
  advanceProjectionTelemetry,
  assertGenericProgressDoesNotAdvanceTelemetry,
  assertProjectionMissingTarget,
  assertProjectionRunAttempt,
  assertProjectionRunDurableExecution,
  assertProjectionRunListWindow,
  assertProjectionRunNonEmpty,
  assertProjectionRunQueueInput,
  assertProjectionRunRunning,
  assertProjectionRunStartInput,
  canRequeueProjectionRunAfterEnqueueFailure,
  createProjectionRunClaim,
  createProjectionRunRecord,
  failProjectionRunEnqueue,
  immutableDatasetVersionConflict,
  mergeProjectionRunProgress,
  type PersistedProjectionRunRecord,
  planProjectionRunFinish,
  planProjectionRunReclaim,
  projectionRunNotFound,
  publicProjectionRunRecord,
  requireTelemetryProjectionRun,
  restoreProjectionRun,
  type StoredProjectionRunRecord,
  staleProjectionRunExecution,
} from "@sixb/core/internal/projection-run-storage-provider"
import type {
  AdvanceProjectionTelemetryCheckpointInput,
  ExecutionStorage,
  FailProjectionRunEnqueueInput,
  FinishProjectionRunInput,
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  LockProjectionRunForMaterializationInput,
  ProjectionKind,
  ProjectionRunClaim,
  ProjectionRunProgress,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  QueueProjectionRunInput,
  RecordProjectionMissingTargetInput,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
  UpdateProjectionRunInput,
} from "@sixb/core/storage"
import { PROJECTION_RUN_FAILURE_CODES, ProjectionRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteProjectionRunStorageOptions {
  /** Execution lookup sharing the same provider transaction. */
  executions: ExecutionStorage
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteProjectionRunStorage implements ProjectionRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database
  private readonly executions: ExecutionStorage

  constructor(options: SqliteProjectionRunStorageOptions) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    this.executions = options.executions

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async queue(input: QueueProjectionRunInput): Promise<ProjectionRunRecord> {
    assertProjectionRunQueueInput(input)
    await assertProjectionRunDurableExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      projectionId: input.identity.projectionId,
      datasetId: input.identity.datasetVersion.datasetId,
      datasetVersionId: input.identity.datasetVersion.versionId,
    })

    return runImmediateTransaction(this.db, () => {
      this.assertDatasetVersionIsImmutable(input)
      const existing = this.findRow(input.projectId, input.id)
      if (existing) {
        const restored = restoreProjectionRunRow(existing)
        if (!canRequeueProjectionRunAfterEnqueueFailure(restored, input)) {
          throw duplicateProjectionRun(input)
        }
        const queuedAt = input.queuedAt ?? new Date()
        const result = this.db
          .query(
            `
              UPDATE projection_runs
              SET status = 'queued', queued_at = ?, started_at = NULL, finished_at = NULL,
                attempt = 0, execution_token = NULL, next_batch_ordinal = ?, next_row_offset = ?,
                input_exhausted = ?, missing_target_object_type_id = NULL,
                missing_target_object_id = NULL, missing_target_batch_ordinal = NULL,
                missing_target_first_seen_at = NULL, source_rows_read = 0,
                source_rows_skipped = 0, error = NULL
              WHERE project_id = ? AND id = ? AND status = 'failed'
                AND json_extract(error, '$.code') = 'queue.enqueue_failed'
            `
          )
          .run(
            queuedAt.toISOString(),
            input.fixedBatchSize === undefined ? null : 0,
            input.fixedBatchSize === undefined ? null : 0,
            input.fixedBatchSize === undefined ? null : 0,
            input.projectId,
            input.id
          )
        if (result.changes !== 1) throw duplicateProjectionRun(input)
        return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
      }

      const record = createProjectionRunRecord(input)
      try {
        this.insertQueued(record)
      } catch (error) {
        if (isUniqueConstraintError(error)) throw duplicateProjectionRun(input)
        throw error
      }
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim> {
    return runImmediateTransaction(this.db, () => {
      assertProjectionRunStartInput(input)

      const metadataConflict = this.db
        .query(
          `
            SELECT 1 FROM projection_runs
            WHERE project_id = ? AND id <> ? AND dataset_id = ? AND dataset_version_id = ?
              AND dataset_version_created_at IS NOT NULL
              AND dataset_version_created_at <> ?
            LIMIT 1
          `
        )
        .get(
          input.projectId,
          input.id,
          input.identity.datasetVersion.datasetId,
          input.identity.datasetVersion.versionId,
          input.identity.datasetVersion.createdAt
        )
      if (metadataConflict) {
        throw immutableDatasetVersionConflict(input.identity)
      }

      const existing = this.requireRow(input.projectId, input.id)
      const existingRecord = restoreProjectionRunRow(existing)
      const attempt = planProjectionRunReclaim(existingRecord, input).attempt

      const executionToken = createFreshExecutionToken(existing.execution_token)
      const result = this.db
        .query(
          `
            UPDATE projection_runs
            SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL,
              attempt = ?, execution_token = ?, error = NULL
            WHERE project_id = ? AND id = ?
              AND (
                (status = 'queued' AND execution_token IS NULL)
                OR (status = 'running' AND execution_token = ?)
              )
          `
        )
        .run(
          (input.startedAt ?? new Date()).toISOString(),
          attempt,
          executionToken,
          input.projectId,
          input.id,
          existing.execution_token
        )
      if (result.changes !== 1) throw staleProjectionRunExecution(input.id)

      return projectionRunClaim(this.requireRow(input.projectId, input.id))
    })
  }

  async failEnqueue(input: FailProjectionRunEnqueueInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = restoreProjectionRunRow(this.requireRow(input.projectId, input.id))
      const failed = failProjectionRunEnqueue(existing, input)
      if (!failed.finishedAt || !failed.error) {
        throw new ProjectionRunError(`[SixbSqlite] Projection run '${input.id}' did not finish.`)
      }
      const result = this.db
        .query(
          `
            UPDATE projection_runs
            SET status = 'failed', finished_at = ?, error = ?
            WHERE project_id = ? AND id = ? AND status = 'queued'
          `
        )
        .run(
          failed.finishedAt.toISOString(),
          serializeSixbFailure(failed.error, PROJECTION_RUN_FAILURE_CODES),
          input.projectId,
          input.id
        )
      if (result.changes !== 1) throw duplicateProjectionRun(input)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async lockForMaterialization(
    input: LockProjectionRunForMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return rowToProjectionRunRecord(this.requireMaterializationExecution(input))
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existingRow = this.requireMaterializationExecution(input)
      const existing = restoreProjectionRunRow(existingRow)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, input.progress)
      const progress = mergeProjectionRunProgress(existing.progress, input.progress)
      const result = this.updateProgress(existingRow, progress, input.executionToken)
      if (result !== 1) throw staleProjectionRunExecution(input.id)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existingRow = this.requireMaterializationExecution(input)
      const plan = planProjectionRunFinish(restoreProjectionRunRow(existingRow), input)
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            status = ?,
            finished_at = ?,
            execution_token = NULL,
            source_rows_read = ?,
            source_rows_skipped = ?,
            input_exhausted = ?,
            error = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
        `
        )
        .run(
          input.status,
          plan.finishedAt.toISOString(),
          plan.progress.sourceRowsRead,
          plan.progress.sourceRowsSkipped,
          plan.inputExhausted ? 1 : existingRow.input_exhausted,
          plan.error === undefined
            ? null
            : serializeSixbFailure(plan.error, PROJECTION_RUN_FAILURE_CODES),
          input.projectId,
          input.id,
          input.executionToken
        )
      if (result.changes !== 1) throw staleProjectionRunExecution(input.id)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<TelemetryProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      const advance = advanceProjectionTelemetry(restoreProjectionRunRow(existing), input)
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            next_batch_ordinal = ?,
            next_row_offset = ?,
            input_exhausted = ?,
            source_rows_read = ?,
            source_rows_skipped = ?,
            missing_target_object_type_id = NULL,
            missing_target_object_id = NULL,
            missing_target_batch_ordinal = NULL,
            missing_target_first_seen_at = NULL
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
            AND next_batch_ordinal = ? AND input_exhausted = 0
        `
        )
        .run(
          advance.checkpoint.nextBatchOrdinal,
          advance.checkpoint.nextRowOffset,
          advance.checkpoint.inputExhausted ? 1 : 0,
          advance.progress.sourceRowsRead,
          advance.progress.sourceRowsSkipped,
          input.projectId,
          input.id,
          input.executionToken,
          input.batchOrdinal
        )
      if (result.changes !== 1) throw staleProjectionRunExecution(input.id)
      return rowToTelemetryProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async recordMissingTarget(
    input: RecordProjectionMissingTargetInput
  ): Promise<TelemetryProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      const missingTarget = assertProjectionMissingTarget(
        requireTelemetryProjectionRun(restoreProjectionRunRow(existing)),
        input.missingTarget
      )
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            missing_target_object_type_id = ?,
            missing_target_object_id = ?,
            missing_target_batch_ordinal = ?,
            missing_target_first_seen_at = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
            AND next_batch_ordinal = ?
        `
        )
        .run(
          missingTarget.objectTypeId,
          missingTarget.objectId,
          missingTarget.batchOrdinal,
          missingTarget.firstSeenAt.toISOString(),
          input.projectId,
          input.id,
          input.executionToken,
          missingTarget.batchOrdinal
        )
      if (result.changes !== 1) throw staleProjectionRunExecution(input.id)
      return rowToTelemetryProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    const row = this.findRow(params.projectId, params.id)
    return row ? rowToProjectionRunRecord(row) : null
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    assertProjectionRunNonEmpty(input.projectId, "projectId")

    if (input.statuses && input.statuses.length === 0) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: (string | number)[] = [input.projectId]

    if (input.projectionId) {
      whereClauses.push("projection_id = ?")
      args.push(input.projectionId)
    }
    if (input.projectionKind) {
      whereClauses.push("projection_kind = ?")
      args.push(input.projectionKind)
    }
    if (input.datasetId) {
      whereClauses.push("dataset_id = ?")
      args.push(input.datasetId)
    }
    if (input.datasetVersionId) {
      whereClauses.push("dataset_version_id = ?")
      args.push(input.datasetVersionId)
    }
    if (input.objectTypeIds) {
      if (input.objectTypeIds.length === 0) {
        return { runs: [], hasMore: false, total: 0 }
      }
      const placeholders = input.objectTypeIds.map(() => "?").join(", ")
      whereClauses.push(
        `(object_type_id IN (${placeholders})` +
          ` OR (source_object_type_id IN (${placeholders})` +
          ` AND target_object_type_id IN (${placeholders})))`
      )
      args.push(...input.objectTypeIds, ...input.objectTypeIds, ...input.objectTypeIds)
    }
    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }
    if (input.startedAfter) {
      whereClauses.push("COALESCE(started_at, queued_at) >= ?")
      args.push(input.startedAfter.toISOString())
    }
    if (input.startedBefore) {
      whereClauses.push("COALESCE(started_at, queued_at) <= ?")
      args.push(input.startedBefore.toISOString())
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const limit = input.limit

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM projection_runs ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT * FROM projection_runs
      ${where}
      ORDER BY COALESCE(started_at, queued_at) ${order}, id ${order}
    `
    const queryArgs = [...args]

    if (limit !== undefined) {
      assertProjectionRunListWindow(limit, "limit")
      assertProjectionRunListWindow(offset, "offset")
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      assertProjectionRunListWindow(offset, "offset")
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as DatabaseRow[]
    const runs = rows.map(rowToProjectionRunRecord)
    return { runs, hasMore: offset + runs.length < totalRow.count, total: totalRow.count }
  }

  async listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult> {
    const rows = queryLatestRunsByOwnerId<DatabaseRow>({
      db: this.db,
      tableName: "projection_runs",
      ownerColumn: "projection_id",
      ownerIds: input.projectionIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.projection_id,
    })
    return { runs: rows.map(rowToProjectionRunRecord) }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private assertDatasetVersionIsImmutable(input: QueueProjectionRunInput): void {
    const conflict = this.db
      .query(
        `
          SELECT 1 FROM projection_runs
          WHERE project_id = ? AND id <> ? AND dataset_id = ? AND dataset_version_id = ?
            AND dataset_version_created_at <> ?
          LIMIT 1
        `
      )
      .get(
        input.projectId,
        input.id,
        input.identity.datasetVersion.datasetId,
        input.identity.datasetVersion.versionId,
        input.identity.datasetVersion.createdAt
      )
    if (conflict) throw immutableDatasetVersionConflict(input.identity)
  }

  private insertQueued(record: ProjectionRunRecord): void {
    const checkpoint = record.telemetryCheckpoint
    this.db
      .query(
        `
          INSERT INTO projection_runs (
            project_id, id, execution_id, projection_id, projection_kind,
            materialization_protocol, dataset_id, dataset_version_id,
            dataset_version_created_at, ontology_revision, projection_revision, ownership_hash,
            object_type_id, source_object_type_id, target_object_type_id, status, queued_at,
            started_at, finished_at, attempt, execution_token, fixed_batch_size,
            next_batch_ordinal, next_row_offset, input_exhausted, source_rows_read,
            source_rows_skipped
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, NULL,
            ?, ?, ?, ?, 0, 0
          )
        `
      )
      .run(
        record.projectId,
        record.id,
        record.executionId,
        record.identity.projectionId,
        record.identity.projectionKind,
        record.identity.protocol,
        record.identity.datasetVersion.datasetId,
        record.identity.datasetVersion.versionId,
        record.identity.datasetVersion.createdAt,
        record.identity.ontologyRevision,
        record.identity.projectionRevision,
        record.identity.ownershipHash,
        "objectTypeId" in record.target ? record.target.objectTypeId : null,
        "sourceObjectTypeId" in record.target ? record.target.sourceObjectTypeId : null,
        "sourceObjectTypeId" in record.target ? record.target.targetObjectTypeId : null,
        record.queuedAt.toISOString(),
        checkpoint?.fixedBatchSize ?? null,
        checkpoint?.nextBatchOrdinal ?? null,
        checkpoint?.nextRowOffset ?? null,
        checkpoint === undefined ? null : checkpoint.inputExhausted ? 1 : 0
      )
  }

  private updateProgress(
    existing: DatabaseRow,
    progress: ProjectionRunProgress,
    executionToken: string
  ): number {
    const args: (string | number)[] = [
      progress.sourceRowsRead,
      progress.sourceRowsSkipped,
      existing.project_id,
      existing.id,
      executionToken,
    ]
    const result = this.db
      .query(
        `
        UPDATE projection_runs
        SET
          source_rows_read = ?,
          source_rows_skipped = ?
        WHERE project_id = ? AND id = ? AND status = 'running'
          AND execution_token = ?
      `
      )
      .run(...args)
    return result.changes
  }

  private requireMaterializationExecution(
    input: LockProjectionRunForMaterializationInput
  ): DatabaseRow {
    const row = this.requireRunning(input.projectId, input.id)
    assertProjectionRunAttempt(restoreProjectionRunRow(row), input)
    return row
  }

  private requireRunning(projectId: string, id: string): DatabaseRow {
    const row = this.requireRow(projectId, id)
    assertProjectionRunRunning(restoreProjectionRunRow(row))
    return row
  }

  private findRow(projectId: string, id: string): DatabaseRow | null {
    return this.db
      .query("SELECT * FROM projection_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as DatabaseRow | null
  }

  private requireRow(projectId: string, id: string): DatabaseRow {
    assertProjectionRunNonEmpty(projectId, "projectId")
    assertProjectionRunNonEmpty(id, "id")
    const row = this.findRow(projectId, id)
    if (!row) throw projectionRunNotFound(projectId, id)
    return row
  }
}

function createFreshExecutionToken(previous: string | null): string {
  let token = randomUUID()
  while (token === previous) token = randomUUID()
  return token
}

function rowToProjectionRunRecord(row: DatabaseRow): ProjectionRunRecord {
  return publicProjectionRunRecord(restoreProjectionRunRow(row))
}

function restoreProjectionRunRow(row: DatabaseRow): StoredProjectionRunRecord {
  const persisted: PersistedProjectionRunRecord = {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    projectionId: row.projection_id,
    projectionKind: row.projection_kind,
    protocol: row.materialization_protocol ?? undefined,
    datasetId: row.dataset_id,
    datasetVersionId: row.dataset_version_id,
    datasetVersionCreatedAt: row.dataset_version_created_at ?? undefined,
    ontologyRevision: row.ontology_revision ?? undefined,
    projectionRevision: row.projection_revision ?? undefined,
    ownershipHash: row.ownership_hash ?? undefined,
    objectTypeId: row.object_type_id ?? undefined,
    sourceObjectTypeId: row.source_object_type_id ?? undefined,
    targetObjectTypeId: row.target_object_type_id ?? undefined,
    status: row.status,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    attempt: databaseSafeInteger(row.attempt, "attempt"),
    executionToken: row.execution_token ?? undefined,
    fixedBatchSize: optionalDatabaseSafeInteger(row.fixed_batch_size, "fixedBatchSize"),
    nextBatchOrdinal: optionalDatabaseSafeInteger(row.next_batch_ordinal, "nextBatchOrdinal"),
    nextRowOffset: optionalDatabaseSafeInteger(row.next_row_offset, "nextRowOffset"),
    inputExhausted: row.input_exhausted === null ? undefined : row.input_exhausted === 1,
    missingTargetObjectTypeId: row.missing_target_object_type_id ?? undefined,
    missingTargetObjectId: row.missing_target_object_id ?? undefined,
    missingTargetBatchOrdinal: optionalDatabaseSafeInteger(
      row.missing_target_batch_ordinal,
      "missingTargetBatchOrdinal"
    ),
    missingTargetFirstSeenAt: row.missing_target_first_seen_at
      ? new Date(row.missing_target_first_seen_at)
      : undefined,
    progress: {
      sourceRowsRead: databaseSafeInteger(row.source_rows_read, "sourceRowsRead"),
      sourceRowsSkipped: databaseSafeInteger(row.source_rows_skipped, "sourceRowsSkipped"),
    },
    error: row.error ?? undefined,
  }
  return restoreProjectionRun(persisted)
}

function projectionRunClaim(row: DatabaseRow): ProjectionRunClaim {
  return createProjectionRunClaim(restoreProjectionRunRow(row))
}

function rowToTelemetryProjectionRunRecord(row: DatabaseRow): TelemetryProjectionRunRecord {
  return requireTelemetryProjectionRun(rowToProjectionRunRecord(row))
}

function optionalDatabaseSafeInteger(value: number | null, fieldName: string): number | undefined {
  return value === null ? undefined : databaseSafeInteger(value, fieldName)
}

function databaseSafeInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run persisted ${fieldName} is not a non-negative safe integer.`
    )
  }
  return value
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

interface DatabaseRow {
  project_id: string
  id: string
  execution_id: string
  projection_id: string
  projection_kind: ProjectionKind
  materialization_protocol: "replacement" | "telemetry" | null
  dataset_id: string
  dataset_version_id: string
  dataset_version_created_at: string | null
  ontology_revision: string | null
  projection_revision: string | null
  ownership_hash: string | null
  object_type_id: string | null
  source_object_type_id: string | null
  target_object_type_id: string | null
  status: ProjectionRunStatus
  queued_at: string
  started_at: string | null
  finished_at: string | null
  attempt: number
  execution_token: string | null
  fixed_batch_size: number | null
  next_batch_ordinal: number | null
  next_row_offset: number | null
  input_exhausted: 0 | 1 | null
  missing_target_object_type_id: string | null
  missing_target_object_id: string | null
  missing_target_batch_ordinal: number | null
  missing_target_first_seen_at: string | null
  source_rows_read: number
  source_rows_skipped: number
  error: string | null
}

function duplicateProjectionRun(input: { readonly projectId: string; readonly id: string }) {
  return new ProjectionRunError(
    `[SixbSqlite] Projection run '${input.id}' already exists for project '${input.projectId}'.`
  )
}
