import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import type {
  AdvanceProjectionTelemetryCheckpointInput,
  AssertProjectionMaterializationExecutionInput,
  CompleteEmptyProjectionTelemetryInput,
  FinishProjectionMaterializationInput,
  FinishProjectionRunInput,
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionKind,
  ProjectionMaterializationRunRecord,
  ProjectionMaterializationRunStorage,
  ProjectionRunCounters,
  ProjectionRunObjectTypes,
  ProjectionRunRecord,
  ProjectionRunStatus,
  StartOrReclaimProjectionMaterializationInput,
  StartProjectionRunInput,
  UpdateProjectionMaterializationInput,
  UpdateProjectionRunInput,
} from "@sixb/core/storage"
import { PROJECTION_COUNTER_KEYS, ProjectionRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "./transactions"

type ProjectionMaterializationIdentity = StartOrReclaimProjectionMaterializationInput["identity"]

export interface SqliteProjectionRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteProjectionRunStorage implements ProjectionMaterializationRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteProjectionRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async startOrReclaimMaterialization(
    input: StartOrReclaimProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runImmediateTransaction(this.db, () => {
      assertNonEmpty(input.id, "id")
      assertNonEmpty(input.projectId, "projectId")
      assertIdentity(input.identity)
      assertObjectTypes(input.identity.projectionKind, input)
      if (input.identity.protocol === "telemetry") {
        assertPositiveCounter(input.fixedBatchSize ?? 0, "fixedBatchSize")
      } else if (input.fixedBatchSize !== undefined) {
        throw new ProjectionRunError(
          "[SixbSqlite] Replacement projection runs cannot declare a telemetry fixedBatchSize."
        )
      }

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
        throw new ProjectionRunError(
          `[SixbSqlite] Dataset version '${input.identity.datasetVersion.versionId}' reused an immutable dataset version id with different metadata.`
        )
      }

      const existing = this.findRow(input.projectId, input.id)
      if (existing) {
        this.assertRunning(existing)
        assertMaterializationIdentityMatches(existing, input.identity)
        assertObjectTypesMatch(existing, input)
        if (checkpointFromRow(existing)?.fixedBatchSize !== input.fixedBatchSize) {
          throw new ProjectionRunError(
            `[SixbSqlite] Projection run '${input.id}' fixed batch size does not match.`
          )
        }
        assertCompleteMaterializationRow(existing)
      }

      const previousAttempt = existing?.attempt ?? 0
      if (!Number.isSafeInteger(previousAttempt + 1)) {
        throw new ProjectionRunError(
          `[SixbSqlite] Projection run '${input.id}' attempt exceeds safe integer range.`
        )
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
          .run(
            previousAttempt + 1,
            executionToken,
            input.projectId,
            input.id,
            existing.execution_token
          )
        if (result.changes !== 1) throw staleExecutionTokenError(input.id)
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
                rows_processed,
                rows_skipped,
                objects_upserted,
                links_upserted,
                telemetry_points_appended,
                telemetry_points_skipped,
                telemetry_rows_failed
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?,
                0, 0, 0, 0, 0, 0, 0
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
              input.objectTypeId ?? null,
              input.sourceObjectTypeId ?? null,
              input.targetObjectTypeId ?? null,
              (input.startedAt ?? new Date()).toISOString(),
              executionToken,
              input.fixedBatchSize ?? null,
              input.fixedBatchSize === undefined ? null : 0,
              input.fixedBatchSize === undefined ? null : 0,
              input.fixedBatchSize === undefined ? null : 0
            )
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ProjectionRunError(
              `[SixbSqlite] Projection run '${input.id}' already exists for project '${input.projectId}'.`
            )
          }
          throw error
        }
      }

      return rowToProjectionMaterializationRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async assertMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return rowToProjectionMaterializationRunRecord(this.requireMaterializationExecution(input))
  }

  async updateMaterialization(
    input: UpdateProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      const counters = mergeCounters(rowToCounters(existing), input)
      const result = this.updateCounters(existing, counters, input.executionToken)
      if (result !== 1) throw staleExecutionTokenError(input.id)
      return rowToProjectionMaterializationRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async finishMaterialization(
    input: FinishProjectionMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      if (
        input.status === "succeeded" &&
        existing.materialization_protocol === "telemetry" &&
        existing.input_exhausted !== 1
      ) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' cannot succeed before its input is exhausted.`
        )
      }
      const counters = mergeCounters(rowToCounters(existing), input)
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            status = ?,
            finished_at = ?,
            execution_token = NULL,
            rows_processed = ?,
            rows_skipped = ?,
            objects_upserted = ?,
            links_upserted = ?,
            telemetry_points_appended = ?,
            telemetry_points_skipped = ?,
            telemetry_rows_failed = ?,
            error_message = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          counters.rowsProcessed,
          counters.rowsSkipped,
          counters.objectsUpserted,
          counters.linksUpserted,
          counters.telemetryPointsAppended,
          counters.telemetryPointsSkipped,
          counters.telemetryRowsFailed,
          input.status === "succeeded" ? null : (input.errorMessage ?? null),
          input.projectId,
          input.id,
          input.executionToken
        )
      if (result.changes !== 1) throw staleExecutionTokenError(input.id)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      if (existing.materialization_protocol !== "telemetry") {
        throw new ProjectionRunError(
          `[SixbSqlite] Projection run '${existing.id}' does not have a telemetry checkpoint.`
        )
      }
      const checkpoint = checkpointFromRow(existing)
      if (!checkpoint) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' has incomplete checkpoint state.`
        )
      }
      assertCounter(input.batchOrdinal, "batchOrdinal")
      assertPositiveCounter(input.batchRowCount, "batchRowCount")
      if (input.batchOrdinal !== checkpoint.nextBatchOrdinal) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' expected batch ordinal ${checkpoint.nextBatchOrdinal}, got ${input.batchOrdinal}.`
        )
      }
      if (input.batchRowCount > checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' batch exceeds its fixed size.`
        )
      }
      if (!input.inputExhausted && input.batchRowCount !== checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' cannot advance past a partial non-final batch.`
        )
      }
      if (checkpoint.inputExhausted) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' has already exhausted its input.`
        )
      }

      const nextBatchOrdinal = safeAdd(checkpoint.nextBatchOrdinal, 1, "nextBatchOrdinal")
      const nextRowOffset = safeAdd(checkpoint.nextRowOffset, input.batchRowCount, "nextRowOffset")
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET next_batch_ordinal = ?, next_row_offset = ?, input_exhausted = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
            AND next_batch_ordinal = ? AND input_exhausted = 0
        `
        )
        .run(
          nextBatchOrdinal,
          nextRowOffset,
          input.inputExhausted ? 1 : 0,
          input.projectId,
          input.id,
          input.executionToken,
          input.batchOrdinal
        )
      if (result.changes !== 1) throw staleExecutionTokenError(input.id)
      return rowToProjectionMaterializationRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async completeEmptyTelemetryInput(
    input: CompleteEmptyProjectionTelemetryInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      const checkpoint = checkpointFromRow(existing)
      if (existing.materialization_protocol !== "telemetry" || !checkpoint) {
        throw new ProjectionRunError(
          `[SixbSqlite] Projection run '${existing.id}' does not have a telemetry checkpoint.`
        )
      }
      if (
        checkpoint.nextBatchOrdinal !== 0 ||
        checkpoint.nextRowOffset !== 0 ||
        checkpoint.inputExhausted
      ) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' cannot declare empty input after progress.`
        )
      }

      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET input_exhausted = 1
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
            AND next_batch_ordinal = 0 AND next_row_offset = 0 AND input_exhausted = 0
        `
        )
        .run(input.projectId, input.id, input.executionToken)
      if (result.changes !== 1) throw staleExecutionTokenError(input.id)
      return rowToProjectionMaterializationRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async start(input: StartProjectionRunInput): Promise<ProjectionRunRecord> {
    assertNonEmpty(input.id, "id")
    assertNonEmpty(input.projectId, "projectId")
    assertNonEmpty(input.projectionId, "projectionId")
    assertNonEmpty(input.datasetId, "datasetId")
    assertNonEmpty(input.datasetVersionId, "datasetVersionId")

    try {
      this.db
        .query(
          `
          INSERT INTO projection_runs (
            project_id,
            id,
            projection_id,
            projection_kind,
            dataset_id,
            dataset_version_id,
            object_type_id,
            source_object_type_id,
            target_object_type_id,
            status,
            started_at,
            attempt,
            rows_processed,
            rows_skipped,
            objects_upserted,
            links_upserted,
            telemetry_points_appended,
            telemetry_points_skipped,
            telemetry_rows_failed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, 0, 0, 0, 0, 0)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.projectionId,
          input.projectionKind,
          input.datasetId,
          input.datasetVersionId,
          input.objectTypeId ?? null,
          input.sourceObjectTypeId ?? null,
          input.targetObjectTypeId ?? null,
          (input.startedAt ?? new Date()).toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ProjectionRunError(
          `[SixbSqlite] Projection run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new ProjectionRunError(
        `[SixbSqlite] Failed to load projection run '${input.id}' for project '${input.projectId}'.`
      )
    }
    return record
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireRunning(input.projectId, input.id)
      assertLegacyMutationAllowed(existing, "update")
      const counters = mergeCounters(rowToCounters(existing), input)
      this.updateCounters(existing, counters)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireRunning(input.projectId, input.id)
      assertLegacyMutationAllowed(existing, "finish")
      const counters = mergeCounters(rowToCounters(existing), input)

      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            status = ?,
            finished_at = ?,
            rows_processed = ?,
            rows_skipped = ?,
            objects_upserted = ?,
            links_upserted = ?,
            telemetry_points_appended = ?,
            telemetry_points_skipped = ?,
            telemetry_rows_failed = ?,
            error_message = ?
          WHERE project_id = ? AND id = ? AND status = 'running'
            AND materialization_protocol IS NULL
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          counters.rowsProcessed,
          counters.rowsSkipped,
          counters.objectsUpserted,
          counters.linksUpserted,
          counters.telemetryPointsAppended,
          counters.telemetryPointsSkipped,
          counters.telemetryRowsFailed,
          input.status === "succeeded" ? null : (input.errorMessage ?? null),
          input.projectId,
          input.id
        )
      if (result.changes !== 1) throw invalidLegacyTransition(input.id, "finish")

      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    const row = this.findRow(params.projectId, params.id)
    return row ? rowToProjectionRunRecord(row) : null
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    assertNonEmpty(input.projectId, "projectId")

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
      assertListWindowValue(limit, "limit")
      assertListWindowValue(offset, "offset")
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      assertListWindowValue(offset, "offset")
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

  private updateCounters(
    existing: DatabaseRow,
    counters: ProjectionRunCounters,
    executionToken?: string
  ): number {
    const tokenPredicate = executionToken === undefined ? "" : " AND execution_token = ?"
    const args: (string | number)[] = [
      counters.rowsProcessed,
      counters.rowsSkipped,
      counters.objectsUpserted,
      counters.linksUpserted,
      counters.telemetryPointsAppended,
      counters.telemetryPointsSkipped,
      counters.telemetryRowsFailed,
      existing.project_id,
      existing.id,
    ]
    if (executionToken !== undefined) args.push(executionToken)
    const result = this.db
      .query(
        `
        UPDATE projection_runs
        SET
          rows_processed = ?,
          rows_skipped = ?,
          objects_upserted = ?,
          links_upserted = ?,
          telemetry_points_appended = ?,
          telemetry_points_skipped = ?,
          telemetry_rows_failed = ?
        WHERE project_id = ? AND id = ? AND status = 'running'
          AND materialization_protocol ${executionToken === undefined ? "IS NULL" : "IS NOT NULL"}${tokenPredicate}
      `
      )
      .run(...args)
    if (result.changes !== 1 && executionToken === undefined) {
      throw invalidLegacyTransition(existing.id, "update")
    }
    return result.changes
  }

  private requireMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): DatabaseRow {
    assertNonEmpty(input.executionToken, "executionToken")
    assertIdentity(input.identity)
    const row = this.requireRunning(input.projectId, input.id)
    assertMaterializationIdentityMatches(row, input.identity)
    if (!row.execution_token || row.execution_token !== input.executionToken) {
      throw staleExecutionTokenError(input.id)
    }
    assertCompleteMaterializationRow(row)
    return row
  }

  private requireRunning(projectId: string, id: string): DatabaseRow {
    const row = this.requireRow(projectId, id)
    this.assertRunning(row)
    return row
  }

  private assertRunning(row: DatabaseRow): void {
    if (row.status !== "running") {
      throw new ProjectionRunError(
        `[SixbSqlite] Projection run '${row.id}' for project '${row.project_id}' is already terminal.`
      )
    }
  }

  private findRow(projectId: string, id: string): DatabaseRow | null {
    return this.db
      .query("SELECT * FROM projection_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as DatabaseRow | null
  }

  private requireRow(projectId: string, id: string): DatabaseRow {
    assertNonEmpty(projectId, "projectId")
    assertNonEmpty(id, "id")
    const row = this.findRow(projectId, id)
    if (!row) {
      throw new ProjectionRunError(
        `[SixbSqlite] Projection run '${id}' not found for project '${projectId}'.`
      )
    }
    return row
  }
}

function createFreshExecutionToken(previous: string | null): string {
  let token = randomUUID()
  while (token === previous) token = randomUUID()
  return token
}

function staleExecutionTokenError(id: string): ProjectionRunError {
  return new ProjectionRunError(
    `[SixbSqlite] Projection run '${id}' execution token is stale.`,
    "execution-lost"
  )
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionRunError(`[SixbSqlite] Projection run ${fieldName} must not be empty.`)
  }
}

function assertCanonicalTimestamp(value: string, fieldName: string): void {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run ${fieldName} must be a canonical UTC timestamp.`
    )
  }
}

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run ${fieldName} must be a non-negative safe integer.`
    )
  }
}

function assertPositiveCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run ${fieldName} must be a positive safe integer.`
    )
  }
}

function assertOptionalCounter(value: number | undefined, fieldName: string): void {
  if (value !== undefined) assertCounter(value, fieldName)
}

function assertListWindowValue(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(`[SixbSqlite] Projection run list ${fieldName} must be >= 0.`)
  }
}

function safeAdd(left: number, right: number, fieldName: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run ${fieldName} exceeds safe integer range.`
    )
  }
  return result
}

function assertIdentity(identity: ProjectionMaterializationIdentity): void {
  assertNonEmpty(identity.projectionId, "projectionId")
  if (
    identity.projectionKind !== "object" &&
    identity.projectionKind !== "link" &&
    identity.projectionKind !== "telemetry"
  ) {
    throw new ProjectionRunError(
      "[SixbSqlite] Projection run projectionKind must be 'object', 'link', or 'telemetry'."
    )
  }
  if (identity.protocol !== "replacement" && identity.protocol !== "telemetry") {
    throw new ProjectionRunError(
      "[SixbSqlite] Projection run protocol must be 'replacement' or 'telemetry'."
    )
  }
  assertNonEmpty(identity.datasetVersion.datasetId, "datasetId")
  assertNonEmpty(identity.datasetVersion.versionId, "datasetVersionId")
  assertCanonicalTimestamp(identity.datasetVersion.createdAt, "datasetVersionCreatedAt")
  assertNonEmpty(identity.ontologyRevision, "ontologyRevision")
  assertNonEmpty(identity.projectionRevision, "projectionRevision")
  assertNonEmpty(identity.ownershipHash, "ownershipHash")
  if ((identity.protocol === "telemetry") !== (identity.projectionKind === "telemetry")) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run protocol '${identity.protocol}' is incompatible with kind '${identity.projectionKind}'.`
    )
  }
}

function assertObjectTypes(kind: ProjectionKind, input: ProjectionRunObjectTypes): void {
  if (kind === "link") {
    assertNonEmpty(input.sourceObjectTypeId ?? "", "sourceObjectTypeId")
    assertNonEmpty(input.targetObjectTypeId ?? "", "targetObjectTypeId")
    if (input.objectTypeId !== undefined) {
      throw new ProjectionRunError(
        "[SixbSqlite] Link projection runs cannot declare a singular objectTypeId."
      )
    }
    return
  }
  assertNonEmpty(input.objectTypeId ?? "", "objectTypeId")
  if (input.sourceObjectTypeId !== undefined || input.targetObjectTypeId !== undefined) {
    throw new ProjectionRunError(
      "[SixbSqlite] Object and telemetry projection runs cannot declare link endpoint types."
    )
  }
}

function assertMaterializationIdentityMatches(
  row: DatabaseRow,
  identity: ProjectionMaterializationIdentity
): void {
  if (
    row.projection_id !== identity.projectionId ||
    row.projection_kind !== identity.projectionKind ||
    row.materialization_protocol !== identity.protocol ||
    row.dataset_id !== identity.datasetVersion.datasetId ||
    row.dataset_version_id !== identity.datasetVersion.versionId ||
    row.dataset_version_created_at !== identity.datasetVersion.createdAt ||
    row.ontology_revision !== identity.ontologyRevision ||
    row.projection_revision !== identity.projectionRevision ||
    row.ownership_hash !== identity.ownershipHash
  ) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run '${row.id}' materialization identity does not match.`
    )
  }
}

function assertObjectTypesMatch(row: DatabaseRow, input: ProjectionRunObjectTypes): void {
  if (
    (row.object_type_id ?? undefined) !== input.objectTypeId ||
    (row.source_object_type_id ?? undefined) !== input.sourceObjectTypeId ||
    (row.target_object_type_id ?? undefined) !== input.targetObjectTypeId
  ) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run '${row.id}' target object types do not match.`
    )
  }
}

function assertCompleteMaterializationRow(row: DatabaseRow): void {
  if (
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    !row.execution_token ||
    !row.materialization_protocol ||
    !row.dataset_version_created_at ||
    !row.ontology_revision ||
    !row.projection_revision ||
    !row.ownership_hash
  ) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run '${row.id}' has incomplete materialization state.`
    )
  }
  if (row.materialization_protocol === "telemetry" && !checkpointFromRow(row)) {
    throw new ProjectionRunError(
      `[SixbSqlite] Telemetry projection run '${row.id}' has incomplete checkpoint state.`
    )
  }
}

function assertLegacyMutationAllowed(row: DatabaseRow, operation: "update" | "finish"): void {
  if (row.materialization_protocol !== null) throw invalidLegacyTransition(row.id, operation)
}

function invalidLegacyTransition(id: string, operation: "update" | "finish"): ProjectionRunError {
  return new ProjectionRunError(
    `[SixbSqlite] Projection materialization run '${id}' cannot use legacy ${operation}(); use ${operation}Materialization() with the current execution token.`
  )
}

function mergeCounters(
  existing: ProjectionRunCounters,
  input: Partial<ProjectionRunCounters>
): ProjectionRunCounters {
  const merged = {} as Record<keyof ProjectionRunCounters, number>
  for (const key of PROJECTION_COUNTER_KEYS) {
    assertOptionalCounter(input[key], key)
    merged[key] = input[key] ?? existing[key]
  }
  return merged
}

function rowToCounters(row: DatabaseRow): ProjectionRunCounters {
  return {
    rowsProcessed: databaseSafeInteger(row.rows_processed, "rowsProcessed"),
    rowsSkipped: databaseSafeInteger(row.rows_skipped, "rowsSkipped"),
    objectsUpserted: databaseSafeInteger(row.objects_upserted, "objectsUpserted"),
    linksUpserted: databaseSafeInteger(row.links_upserted, "linksUpserted"),
    telemetryPointsAppended: databaseSafeInteger(
      row.telemetry_points_appended,
      "telemetryPointsAppended"
    ),
    telemetryPointsSkipped: databaseSafeInteger(
      row.telemetry_points_skipped,
      "telemetryPointsSkipped"
    ),
    telemetryRowsFailed: databaseSafeInteger(row.telemetry_rows_failed, "telemetryRowsFailed"),
  }
}

function checkpointFromRow(row: DatabaseRow): ProjectionRunRecord["telemetryCheckpoint"] {
  if (
    row.fixed_batch_size === null ||
    row.next_batch_ordinal === null ||
    row.next_row_offset === null ||
    row.input_exhausted === null
  ) {
    return undefined
  }
  return {
    fixedBatchSize: databaseSafeInteger(row.fixed_batch_size, "fixedBatchSize"),
    nextBatchOrdinal: databaseSafeInteger(row.next_batch_ordinal, "nextBatchOrdinal"),
    nextRowOffset: databaseSafeInteger(row.next_row_offset, "nextRowOffset"),
    inputExhausted: row.input_exhausted === 1,
  }
}

function rowToProjectionRunRecord(row: DatabaseRow): ProjectionRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectionId: row.projection_id,
    projectionKind: row.projection_kind,
    datasetId: row.dataset_id,
    datasetVersionId: row.dataset_version_id,
    objectTypeId: row.object_type_id ?? undefined,
    sourceObjectTypeId: row.source_object_type_id ?? undefined,
    targetObjectTypeId: row.target_object_type_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    attempt: databaseSafeInteger(row.attempt, "attempt"),
    materializationProtocol: row.materialization_protocol ?? undefined,
    datasetVersionCreatedAt: row.dataset_version_created_at ?? undefined,
    ontologyRevision: row.ontology_revision ?? undefined,
    projectionRevision: row.projection_revision ?? undefined,
    ownershipHash: row.ownership_hash ?? undefined,
    telemetryCheckpoint: checkpointFromRow(row),
    ...rowToCounters(row),
    errorMessage: row.error_message ?? undefined,
  }
}

function rowToProjectionMaterializationRunRecord(
  row: DatabaseRow
): ProjectionMaterializationRunRecord {
  assertCompleteMaterializationRow(row)
  return {
    ...rowToProjectionRunRecord(row),
    attempt: databaseSafeInteger(row.attempt, "attempt"),
    executionToken: row.execution_token!,
    materializationProtocol: row.materialization_protocol!,
    datasetVersionCreatedAt: row.dataset_version_created_at!,
    ontologyRevision: row.ontology_revision!,
    projectionRevision: row.projection_revision!,
    ownershipHash: row.ownership_hash!,
  }
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
  rows_processed: number
  rows_skipped: number
  objects_upserted: number
  links_upserted: number
  telemetry_points_appended: number
  telemetry_points_skipped: number
  telemetry_rows_failed: number
  error_message: string | null
}
