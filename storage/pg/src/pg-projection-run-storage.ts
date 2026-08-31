import { randomUUID } from "node:crypto"
import type { JsonValue } from "@sixb/core"
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
import type { SQLClient, SqlParameter } from "./pg-client"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

export class PgProjectionRunStorage implements ProjectionRunStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

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

    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [
        projectionRunLockKey(input.projectId, input.id),
        datasetVersionLockKey(
          input.projectId,
          input.identity.datasetVersion.datasetId,
          input.identity.datasetVersion.versionId
        ),
      ])
      await assertDatasetVersionIsImmutable(tx, input)
      const [existingRow] = await tx<DatabaseRow[]>`
        SELECT * FROM projection_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (existingRow) {
        if (
          !canRequeueProjectionRunAfterEnqueueFailure(rowToProjectionRunRecord(existingRow), input)
        ) {
          throw duplicateProjectionRun(input)
        }
        const [requeued] = await tx<DatabaseRow[]>`
          UPDATE projection_runs
          SET status = ${"queued"}, queued_at = ${input.queuedAt ?? new Date()},
            started_at = ${null}, finished_at = ${null}, attempt = ${0}, execution_token = ${null},
            next_batch_ordinal = ${input.fixedBatchSize === undefined ? null : 0},
            next_row_offset = ${input.fixedBatchSize === undefined ? null : 0},
            input_exhausted = ${input.fixedBatchSize === undefined ? null : false},
            missing_target_object_type_id = ${null}, missing_target_object_id = ${null},
            missing_target_batch_ordinal = ${null}, missing_target_first_seen_at = ${null},
            source_rows_read = ${0}, source_rows_skipped = ${0}, error = ${null}
          WHERE project_id = ${input.projectId} AND id = ${input.id}
            AND status = ${"failed"} AND error->>'code' = ${"queue.enqueue_failed"}
          RETURNING *
        `
        if (!requeued) throw duplicateProjectionRun(input)
        return rowToProjectionRunRecord(requeued)
      }

      const record = createProjectionRunRecord(input)
      const checkpoint = record.telemetryCheckpoint
      const [inserted] = await tx<DatabaseRow[]>`
        INSERT INTO projection_runs (
          project_id, id, execution_id, projection_id, projection_kind,
          materialization_protocol, dataset_id, dataset_version_id,
          dataset_version_created_at, ontology_revision, projection_revision, ownership_hash,
          object_type_id, source_object_type_id, target_object_type_id, status, queued_at,
          started_at, finished_at, attempt, execution_token, fixed_batch_size,
          next_batch_ordinal, next_row_offset, input_exhausted, source_rows_read,
          source_rows_skipped
        ) VALUES (
          ${record.projectId}, ${record.id}, ${record.executionId},
          ${record.identity.projectionId}, ${record.identity.projectionKind},
          ${record.identity.protocol}, ${record.identity.datasetVersion.datasetId},
          ${record.identity.datasetVersion.versionId}, ${record.identity.datasetVersion.createdAt},
          ${record.identity.ontologyRevision}, ${record.identity.projectionRevision},
          ${record.identity.ownershipHash},
          ${"objectTypeId" in record.target ? record.target.objectTypeId : null},
          ${"sourceObjectTypeId" in record.target ? record.target.sourceObjectTypeId : null},
          ${"sourceObjectTypeId" in record.target ? record.target.targetObjectTypeId : null},
          ${"queued"}, ${record.queuedAt}, ${null}, ${null}, ${0}, ${null},
          ${checkpoint?.fixedBatchSize ?? null}, ${checkpoint?.nextBatchOrdinal ?? null},
          ${checkpoint?.nextRowOffset ?? null}, ${checkpoint?.inputExhausted ?? null}, ${0}, ${0}
        )
        RETURNING *
      `
      return rowToProjectionRunRecord(inserted)
    })
  }

  async startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim> {
    assertProjectionRunStartInput(input)

    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [projectionRunLockKey(input.projectId, input.id)])
      const [existingRow] = await tx<DatabaseRow[]>`
        SELECT * FROM projection_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!existingRow) throw projectionRunNotFound(input.projectId, input.id)
      const existing = restoreProjectionRunRow(existingRow)
      const { attempt } = planProjectionRunReclaim(existing, input)
      const executionToken = createFreshExecutionToken(existing.executionToken)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET status = ${"running"}, started_at = COALESCE(started_at, ${input.startedAt ?? new Date()}),
          finished_at = ${null}, attempt = ${attempt}, execution_token = ${executionToken},
          error = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
          AND (
            (status = ${"queued"} AND execution_token IS NULL)
            OR (status = ${"running"} AND execution_token = ${existing.executionToken ?? null})
          )
        RETURNING *
      `
      if (!updated) throw staleProjectionRunExecution(input.id)
      return projectionRunClaim(updated)
    })
  }

  async failEnqueue(input: FailProjectionRunEnqueueInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existingRow] = await tx<DatabaseRow[]>`
        SELECT * FROM projection_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!existingRow) throw projectionRunNotFound(input.projectId, input.id)
      const failed = failProjectionRunEnqueue(restoreProjectionRunRow(existingRow), input)
      if (!failed.error) {
        throw new ProjectionRunError(`[SixbPg] Projection run '${input.id}' has no failure.`)
      }
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET status = ${"failed"}, finished_at = ${failed.finishedAt ?? new Date()},
          error = ${serializeSixbFailure(failed.error, PROJECTION_RUN_FAILURE_CODES)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id} AND status = ${"queued"}
        RETURNING *
      `
      if (!updated) throw duplicateProjectionRun(input)
      return rowToProjectionRunRecord(updated)
    })
  }

  async lockForMaterialization(
    input: LockProjectionRunForMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await requireMaterializationExecution(tx, input)
      return rowToProjectionRunRecord(row)
    })
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = restoreProjectionRunRow(existingRow)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, input.progress)
      const progress = mergeProjectionRunProgress(existing.progress, input.progress)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          source_rows_read = ${progress.sourceRowsRead},
          source_rows_skipped = ${progress.sourceRowsSkipped}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
        RETURNING *
      `
      if (!updated) throw staleProjectionRunExecution(input.id)
      return rowToProjectionRunRecord(updated)
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = restoreProjectionRunRow(existingRow)
      const plan = planProjectionRunFinish(existing, input)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          status = ${input.status},
          finished_at = ${plan.finishedAt},
          execution_token = ${null},
          source_rows_read = ${plan.progress.sourceRowsRead},
          source_rows_skipped = ${plan.progress.sourceRowsSkipped},
          input_exhausted = ${plan.inputExhausted ?? existingRow.input_exhausted},
          error = ${plan.error === undefined ? null : serializeSixbFailure(plan.error, PROJECTION_RUN_FAILURE_CODES)}::text::jsonb
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
        RETURNING *
      `
      if (!updated) throw staleProjectionRunExecution(input.id)
      return rowToProjectionRunRecord(updated)
    })
  }

  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<TelemetryProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const advance = advanceProjectionTelemetry(restoreProjectionRunRow(existingRow), input)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          next_batch_ordinal = ${advance.checkpoint.nextBatchOrdinal},
          next_row_offset = ${advance.checkpoint.nextRowOffset},
          input_exhausted = ${advance.checkpoint.inputExhausted},
          source_rows_read = ${advance.progress.sourceRowsRead},
          source_rows_skipped = ${advance.progress.sourceRowsSkipped},
          missing_target_object_type_id = ${null},
          missing_target_object_id = ${null},
          missing_target_batch_ordinal = ${null},
          missing_target_first_seen_at = ${null}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
          AND next_batch_ordinal = ${input.batchOrdinal}
          AND input_exhausted = ${false}
        RETURNING *
      `
      if (!updated) throw staleProjectionRunExecution(input.id)
      return rowToTelemetryProjectionRunRecord(updated)
    })
  }

  async recordMissingTarget(
    input: RecordProjectionMissingTargetInput
  ): Promise<TelemetryProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = requireTelemetryProjectionRun(restoreProjectionRunRow(existingRow))
      const missingTarget = assertProjectionMissingTarget(existing, input.missingTarget)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          missing_target_object_type_id = ${missingTarget.objectTypeId},
          missing_target_object_id = ${missingTarget.objectId},
          missing_target_batch_ordinal = ${missingTarget.batchOrdinal},
          missing_target_first_seen_at = ${missingTarget.firstSeenAt}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
          AND next_batch_ordinal = ${missingTarget.batchOrdinal}
        RETURNING *
      `
      if (!updated) throw staleProjectionRunExecution(input.id)
      return rowToTelemetryProjectionRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    const [row] = await this.sql<DatabaseRow[]>`
      SELECT * FROM projection_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToProjectionRunRecord(row) : null
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    assertProjectionRunNonEmpty(input.projectId, "projectId")

    if (input.statuses && input.statuses.length === 0) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.projectionId) {
      whereClauses.push(`projection_id = $${index++}`)
      params.push(input.projectionId)
    }
    if (input.projectionKind) {
      whereClauses.push(`projection_kind = $${index++}`)
      params.push(input.projectionKind)
    }
    if (input.datasetId) {
      whereClauses.push(`dataset_id = $${index++}`)
      params.push(input.datasetId)
    }
    if (input.datasetVersionId) {
      whereClauses.push(`dataset_version_id = $${index++}`)
      params.push(input.datasetVersionId)
    }

    if (input.objectTypeIds) {
      if (input.objectTypeIds.length === 0) {
        return { runs: [], hasMore: false, total: 0 }
      }
      const placeholders = input.objectTypeIds.map(() => `$${index++}`)
      const list = placeholders.join(", ")
      const sourceList = input.objectTypeIds.map(() => `$${index++}`).join(", ")
      const targetList = input.objectTypeIds.map(() => `$${index++}`).join(", ")
      whereClauses.push(
        `(object_type_id IN (${list})` +
          ` OR (source_object_type_id IN (${sourceList})` +
          ` AND target_object_type_id IN (${targetList})))`
      )
      params.push(...input.objectTypeIds, ...input.objectTypeIds, ...input.objectTypeIds)
    }

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }
    if (input.startedAfter) {
      whereClauses.push(`COALESCE(started_at, queued_at) >= $${index++}`)
      params.push(input.startedAfter)
    }
    if (input.startedBefore) {
      whereClauses.push(`COALESCE(started_at, queued_at) <= $${index++}`)
      params.push(input.startedBefore)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    assertProjectionRunListWindow(input.limit, "limit")
    assertProjectionRunListWindow(offset, "offset")

    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM projection_runs ${where}`,
      params
    )

    const queryParams = [...params]
    let query = `
      SELECT * FROM projection_runs
      ${where}
      ORDER BY COALESCE(started_at, queued_at) ${order}, id ${order}
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
    const runs = rows.map(rowToProjectionRunRecord)
    return { runs, hasMore: offset + runs.length < total, total }
  }

  async listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult> {
    const rows = await queryLatestRunsByOwnerId<DatabaseRow>({
      sql: this.sql,
      tableName: "projection_runs",
      ownerColumn: "projection_id",
      ownerIds: input.projectionIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.projection_id,
    })

    return { runs: rows.map(rowToProjectionRunRecord) }
  }
}

async function requireMaterializationExecution(
  sql: SQLClient,
  input: LockProjectionRunForMaterializationInput
): Promise<DatabaseRow> {
  const row = await requireRunning(sql, input.projectId, input.id)
  assertProjectionRunAttempt(restoreProjectionRunRow(row), input)
  return row
}

async function requireRunning(sql: SQLClient, projectId: string, id: string): Promise<DatabaseRow> {
  assertProjectionRunNonEmpty(projectId, "projectId")
  assertProjectionRunNonEmpty(id, "id")

  const [row] = await sql<DatabaseRow[]>`
    SELECT * FROM projection_runs
    WHERE project_id = ${projectId} AND id = ${id}
    FOR UPDATE
  `
  if (!row) throw projectionRunNotFound(projectId, id)
  assertProjectionRunRunning(restoreProjectionRunRow(row))
  return row
}

async function assertDatasetVersionIsImmutable(
  sql: SQLClient,
  input: QueueProjectionRunInput
): Promise<void> {
  const [conflict] = await sql<{ readonly id: string }[]>`
    SELECT id FROM projection_runs
    WHERE project_id = ${input.projectId}
      AND id <> ${input.id}
      AND dataset_id = ${input.identity.datasetVersion.datasetId}
      AND dataset_version_id = ${input.identity.datasetVersion.versionId}
      AND dataset_version_created_at <> ${input.identity.datasetVersion.createdAt}
    LIMIT 1
  `
  if (conflict) throw immutableDatasetVersionConflict(input.identity)
}

function createFreshExecutionToken(previous: string | undefined): string {
  let token = randomUUID()
  while (token === previous) token = randomUUID()
  return token
}

function projectionRunLockKey(projectId: string, id: string): string {
  return `projection-run:${JSON.stringify([projectId, id])}`
}

function datasetVersionLockKey(projectId: string, datasetId: string, versionId: string): string {
  return `projection-dataset-version:${JSON.stringify([projectId, datasetId, versionId])}`
}

function rowToProjectionRunRecord(row: DatabaseRow): ProjectionRunRecord {
  return publicProjectionRunRecord(restoreProjectionRunRow(row))
}

function projectionRunClaim(row: DatabaseRow): ProjectionRunClaim {
  return createProjectionRunClaim(restoreProjectionRunRow(row))
}

function rowToTelemetryProjectionRunRecord(row: DatabaseRow): TelemetryProjectionRunRecord {
  return requireTelemetryProjectionRun(rowToProjectionRunRecord(row))
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
    inputExhausted: row.input_exhausted ?? undefined,
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

function optionalDatabaseSafeInteger(
  value: number | string | null,
  fieldName: string
): number | undefined {
  return value === null ? undefined : databaseSafeInteger(value, fieldName)
}

function databaseSafeInteger(value: number | string | null, fieldName: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run persisted ${fieldName} is not a non-negative safe integer.`
    )
  }
  return result
}

interface DatabaseRow {
  project_id: string
  id: string
  execution_id: string
  projection_id: string
  projection_kind: ProjectionKind
  dataset_id: string
  dataset_version_id: string
  object_type_id: string | null
  source_object_type_id: string | null
  target_object_type_id: string | null
  status: ProjectionRunStatus
  queued_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  attempt: number | string
  execution_token: string | null
  materialization_protocol: "replacement" | "telemetry" | null
  dataset_version_created_at: string | null
  ontology_revision: string | null
  projection_revision: string | null
  ownership_hash: string | null
  fixed_batch_size: number | string | null
  next_batch_ordinal: number | string | null
  next_row_offset: number | string | null
  input_exhausted: boolean | null
  missing_target_object_type_id: string | null
  missing_target_object_id: string | null
  missing_target_batch_ordinal: number | string | null
  missing_target_first_seen_at: Date | string | null
  source_rows_read: number | string
  source_rows_skipped: number | string
  error: JsonValue | null
}

function duplicateProjectionRun(input: { readonly projectId: string; readonly id: string }) {
  return new ProjectionRunError(
    `[SixbPg] Projection run '${input.id}' already exists for project '${input.projectId}'.`
  )
}
