import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { materializationConflict } from "@sixb/core/internal/materialization"
import {
  advanceProjectionTelemetry,
  assertGenericProgressDoesNotAdvanceTelemetry,
  assertProjectionMissingTarget,
  assertProjectionRunExecution,
  assertProjectionRunListWindow,
  assertProjectionRunNonEmpty,
  assertProjectionRunRunning,
  assertProjectionRunStartInput,
  createProjectionRunClaim,
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
  RecordProjectionMissingTargetInput,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
  UpdateProjectionRunInput,
} from "@sixb/core/storage"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteProjectionRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteProjectionRunStorage implements ProjectionRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteProjectionRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
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

      const existing = this.findRow(input.projectId, input.id)
      let attempt = 1
      if (existing) {
        const existingRecord = restoreProjectionRunRow(existing)
        attempt = planProjectionRunReclaim(existingRecord, input).attempt
      }

      const executionToken = createFreshExecutionToken(existing?.execution_token ?? null)

      if (existing) {
        const result = this.db
          .query(
            `
            UPDATE projection_runs
            SET attempt = ?, execution_token = ?
            WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
          `
          )
          .run(attempt, executionToken, input.projectId, input.id, existing.execution_token)
        if (result.changes !== 1) throw staleProjectionRunExecution(input.id)
      } else {
        try {
          this.db
            .query(
              `
              INSERT INTO projection_runs (
                project_id,
                id,
                projection_id,
                projection_kind,
                materialization_protocol,
                dataset_id,
                dataset_version_id,
                dataset_version_created_at,
                ontology_revision,
                projection_revision,
                ownership_hash,
                object_type_id,
                source_object_type_id,
                target_object_type_id,
                status,
                started_at,
                attempt,
                execution_token,
                fixed_batch_size,
                next_batch_ordinal,
                next_row_offset,
                input_exhausted,
                source_rows_read,
                source_rows_skipped
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?,
                0, 0
              )
            `
            )
            .run(
              input.projectId,
              input.id,
              input.identity.projectionId,
              input.identity.projectionKind,
              input.identity.protocol,
              input.identity.datasetVersion.datasetId,
              input.identity.datasetVersion.versionId,
              input.identity.datasetVersion.createdAt,
              input.identity.ontologyRevision,
              input.identity.projectionRevision,
              input.identity.ownershipHash,
              "objectTypeId" in input.target ? input.target.objectTypeId : null,
              "sourceObjectTypeId" in input.target ? input.target.sourceObjectTypeId : null,
              "sourceObjectTypeId" in input.target ? input.target.targetObjectTypeId : null,
              (input.startedAt ?? new Date()).toISOString(),
              executionToken,
              input.fixedBatchSize ?? null,
              input.fixedBatchSize === undefined ? null : 0,
              input.fixedBatchSize === undefined ? null : 0,
              input.fixedBatchSize === undefined ? null : 0
            )
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw materializationConflict(
              "run-correlation",
              `[SixbSqlite] Projection run '${input.id}' already exists for project '${input.projectId}'.`
            )
          }
          throw error
        }
      }

      return projectionRunClaim(this.requireRow(input.projectId, input.id))
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
          serializeSixbFailure(plan.error),
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
      .query(`SELECT COUNT(*) AS count FROM projection_runs ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT * FROM projection_runs
      ${where}
      ORDER BY started_at ${order}, id ${order}
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
    assertProjectionRunExecution(restoreProjectionRunRow(row), input)
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
    startedAt: new Date(row.started_at),
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
    error: parseSixbFailure(row.error),
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
    throw materializationConflict(
      "run-correlation",
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
  started_at: string
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
