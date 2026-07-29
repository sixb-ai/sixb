import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import type {
  AdvanceProjectionTelemetryCheckpointInput,
  FinishProjectionRunInput,
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  LockProjectionRunForMaterializationInput,
  ProjectionKind,
  ProjectionMaterializationIdentity,
  ProjectionRunClaim,
  ProjectionRunProgress,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
  UpdateProjectionRunInput,
} from "@sixb/core/storage"
import { PROJECTION_RUN_PROGRESS_KEYS, ProjectionRunError } from "@sixb/core/storage"
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
      assertNonEmpty(input.id, "id")
      assertNonEmpty(input.projectId, "projectId")
      assertIdentity(input.identity)
      assertTarget(input.identity.projectionKind, input.target)
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
        assertTargetMatches(existing, input.target)
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
            throw new ProjectionRunError(
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
      const existing = this.requireMaterializationExecution(input)
      const currentProgress = rowToProgress(existing)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, currentProgress, input.progress)
      const progress = mergeProgress(currentProgress, input.progress)
      const result = this.updateProgress(existing, progress, input.executionToken)
      if (result !== 1) throw staleExecutionTokenError(input.id)
      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = this.requireMaterializationExecution(input)
      const currentProgress = rowToProgress(existing)
      const progressPatch = input.progress ?? {}
      assertGenericProgressDoesNotAdvanceTelemetry(existing, currentProgress, progressPatch)
      const progress = mergeProgress(currentProgress, progressPatch)
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
            input_exhausted = CASE
              WHEN materialization_protocol = 'telemetry' AND ? = 'succeeded' THEN 1
              ELSE input_exhausted
            END,
            error_message = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          progress.sourceRowsRead,
          progress.sourceRowsSkipped,
          input.status,
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
  ): Promise<TelemetryProjectionRunRecord> {
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
      assertCounter(input.batchRowsSkipped, "batchRowsSkipped")
      if (input.batchRowsSkipped > input.batchRowCount) {
        throw new ProjectionRunError(
          `[SixbSqlite] Telemetry projection run '${existing.id}' skipped rows exceed its batch row count.`
        )
      }
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
      const nextRowsSkipped = safeAdd(
        rowToProgress(existing).sourceRowsSkipped,
        input.batchRowsSkipped,
        "sourceRowsSkipped"
      )
      const result = this.db
        .query(
          `
          UPDATE projection_runs
          SET
            next_batch_ordinal = ?,
            next_row_offset = ?,
            input_exhausted = ?,
            source_rows_read = ?,
            source_rows_skipped = ?
          WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
            AND next_batch_ordinal = ? AND input_exhausted = 0
        `
        )
        .run(
          nextBatchOrdinal,
          nextRowOffset,
          input.inputExhausted ? 1 : 0,
          nextRowOffset,
          nextRowsSkipped,
          input.projectId,
          input.id,
          input.executionToken,
          input.batchOrdinal
        )
      if (result.changes !== 1) throw staleExecutionTokenError(input.id)
      return rowToTelemetryProjectionRunRecord(this.requireRow(input.projectId, input.id))
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

function assertTarget(
  kind: ProjectionKind,
  target: StartOrReclaimProjectionRunInput["target"]
): void {
  if (kind === "link") {
    if (!("sourceObjectTypeId" in target)) {
      throw new ProjectionRunError(
        "[SixbSqlite] Link projection runs must declare source and target object types."
      )
    }
    assertNonEmpty(target.sourceObjectTypeId, "sourceObjectTypeId")
    assertNonEmpty(target.targetObjectTypeId, "targetObjectTypeId")
    return
  }
  if (!("objectTypeId" in target)) {
    throw new ProjectionRunError(
      "[SixbSqlite] Object and telemetry projection runs must declare one object type."
    )
  }
  assertNonEmpty(target.objectTypeId, "objectTypeId")
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

function assertTargetMatches(
  row: DatabaseRow,
  target: StartOrReclaimProjectionRunInput["target"]
): void {
  const matches =
    "sourceObjectTypeId" in target
      ? row.object_type_id === null &&
        row.source_object_type_id === target.sourceObjectTypeId &&
        row.target_object_type_id === target.targetObjectTypeId
      : row.object_type_id === target.objectTypeId &&
        row.source_object_type_id === null &&
        row.target_object_type_id === null
  if (!matches) {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run '${row.id}' target object types do not match.`
    )
  }
}

function assertCompleteMaterializationRow(row: DatabaseRow): void {
  if (
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
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
  if (row.materialization_protocol === "telemetry") {
    const checkpoint = checkpointFromRow(row)
    if (!checkpoint) {
      throw new ProjectionRunError(
        `[SixbSqlite] Telemetry projection run '${row.id}' has incomplete checkpoint state.`
      )
    }
    if (row.source_rows_read !== checkpoint.nextRowOffset) {
      throw new ProjectionRunError(
        `[SixbSqlite] Telemetry projection run '${row.id}' progress does not match its checkpoint.`
      )
    }
  }
}

function mergeProgress(
  existing: ProjectionRunProgress,
  input: Partial<ProjectionRunProgress>
): ProjectionRunProgress {
  const merged = {} as Record<keyof ProjectionRunProgress, number>
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    assertOptionalCounter(input[key], key)
    const value = input[key] ?? existing[key]
    if (value < existing[key]) {
      throw new ProjectionRunError(`[SixbSqlite] Projection run ${key} must not decrease.`)
    }
    merged[key] = value
  }
  assertProgress(merged)
  return merged
}

function assertProgress(progress: ProjectionRunProgress): void {
  if (progress.sourceRowsSkipped > progress.sourceRowsRead) {
    throw new ProjectionRunError(
      "[SixbSqlite] Projection run sourceRowsSkipped must not exceed sourceRowsRead."
    )
  }
}

function assertGenericProgressDoesNotAdvanceTelemetry(
  row: Pick<DatabaseRow, "id" | "materialization_protocol">,
  current: ProjectionRunProgress,
  input: Partial<ProjectionRunProgress>
): void {
  if (row.materialization_protocol !== "telemetry") return
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) {
    if (input[key] !== undefined && input[key] !== current[key]) {
      throw new ProjectionRunError(
        `[SixbSqlite] Telemetry projection run '${row.id}' progress can only advance with its checkpoint.`
      )
    }
  }
}

function rowToProgress(row: DatabaseRow): ProjectionRunProgress {
  return {
    sourceRowsRead: databaseSafeInteger(row.source_rows_read, "sourceRowsRead"),
    sourceRowsSkipped: databaseSafeInteger(row.source_rows_skipped, "sourceRowsSkipped"),
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
  assertCompleteMaterializationRow(row)
  const base = {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    attempt: databaseSafeInteger(row.attempt, "attempt"),
    progress: rowToProgress(row),
    errorMessage: row.error_message ?? undefined,
  }
  const identity = persistedIdentity(row)
  if (identity.projectionKind === "link") {
    if (!row.source_object_type_id || !row.target_object_type_id || row.object_type_id) {
      throw invalidPersistedTarget(row.id)
    }
    return {
      ...base,
      identity,
      target: {
        sourceObjectTypeId: row.source_object_type_id,
        targetObjectTypeId: row.target_object_type_id,
      },
    }
  }
  if (!row.object_type_id || row.source_object_type_id || row.target_object_type_id) {
    throw invalidPersistedTarget(row.id)
  }
  const checkpoint = checkpointFromRow(row)
  if (identity.projectionKind === "telemetry") {
    if (!checkpoint) {
      throw new ProjectionRunError(
        `[SixbSqlite] Telemetry projection run '${row.id}' has incomplete checkpoint state.`
      )
    }
    return {
      ...base,
      identity,
      target: { objectTypeId: row.object_type_id },
      telemetryCheckpoint: checkpoint,
    }
  }
  if (checkpoint) {
    throw new ProjectionRunError(
      `[SixbSqlite] Replacement projection run '${row.id}' contains a telemetry checkpoint.`
    )
  }
  return { ...base, identity, target: { objectTypeId: row.object_type_id } }
}

function persistedIdentity(row: DatabaseRow): ProjectionMaterializationIdentity {
  return {
    projectionId: row.projection_id,
    projectionKind: row.projection_kind,
    protocol: row.materialization_protocol as "replacement" | "telemetry",
    datasetVersion: {
      datasetId: row.dataset_id,
      versionId: row.dataset_version_id,
      createdAt: row.dataset_version_created_at as string,
    },
    ontologyRevision: row.ontology_revision as string,
    projectionRevision: row.projection_revision as string,
    ownershipHash: row.ownership_hash as string,
  } as ProjectionMaterializationIdentity
}

function projectionRunClaim(row: DatabaseRow): ProjectionRunClaim {
  assertCompleteMaterializationRow(row)
  if (!row.execution_token) {
    throw new ProjectionRunError(`[SixbSqlite] Projection run '${row.id}' has no active execution.`)
  }
  return {
    run: rowToProjectionRunRecord(row),
    execution: { projectionRunId: row.id, executionToken: row.execution_token },
  }
}

function rowToTelemetryProjectionRunRecord(row: DatabaseRow): TelemetryProjectionRunRecord {
  const record = rowToProjectionRunRecord(row)
  if (record.identity.projectionKind !== "telemetry") {
    throw new ProjectionRunError(
      `[SixbSqlite] Projection run '${record.id}' does not have a telemetry checkpoint.`
    )
  }
  return record as TelemetryProjectionRunRecord
}

function invalidPersistedTarget(id: string): ProjectionRunError {
  return new ProjectionRunError(`[SixbSqlite] Projection run '${id}' has an invalid target.`)
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
  source_rows_read: number
  source_rows_skipped: number
  error_message: string | null
}
