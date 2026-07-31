import { randomUUID } from "node:crypto"
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
  requireProjectionRunExecutionToken,
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
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  RecordProjectionMissingTargetInput,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
  UpdateProjectionRunInput,
} from "@sixb/core/storage"
import { ProjectionRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SQLClient, SqlParameter } from "./pg-client"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

export class PgProjectionRunStorage implements ProjectionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim> {
    assertProjectionRunStartInput(input)

    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [
        projectionRunLockKey(input.projectId, input.id),
        datasetVersionLockKey(
          input.projectId,
          input.identity.datasetVersion.datasetId,
          input.identity.datasetVersion.versionId
        ),
      ])
      const [metadataConflict] = await tx<{ readonly id: string }[]>`
        SELECT id FROM projection_runs
        WHERE project_id = ${input.projectId}
          AND id <> ${input.id}
          AND dataset_id = ${input.identity.datasetVersion.datasetId}
          AND dataset_version_id = ${input.identity.datasetVersion.versionId}
          AND dataset_version_created_at IS NOT NULL
          AND dataset_version_created_at <> ${input.identity.datasetVersion.createdAt}
        LIMIT 1
      `
      if (metadataConflict) {
        throw immutableDatasetVersionConflict(input.identity)
      }

      const [existingRow] = await tx<DatabaseRow[]>`
        SELECT * FROM projection_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      const existing = existingRow ? restoreProjectionRunRow(existingRow) : undefined
      const executionToken = createFreshExecutionToken(existing?.executionToken)

      if (existingRow && existing) {
        const { attempt } = planProjectionRunReclaim(existing, input)
        const previousExecutionToken = requireProjectionRunExecutionToken(existing)

        const [updated] = await tx<DatabaseRow[]>`
          UPDATE projection_runs
          SET attempt = ${attempt}, execution_token = ${executionToken}
          WHERE project_id = ${input.projectId}
            AND id = ${input.id}
            AND status = ${"running"}
            AND execution_token = ${previousExecutionToken}
          RETURNING *
        `
        if (!updated) throw staleProjectionRunExecution(input.id)
        return projectionRunClaim(updated)
      }

      const [inserted] = await tx<DatabaseRow[]>`
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
          execution_token,
          materialization_protocol,
          dataset_version_created_at,
          ontology_revision,
          projection_revision,
          ownership_hash,
          fixed_batch_size,
          next_batch_ordinal,
          next_row_offset,
          input_exhausted
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.identity.projectionId},
          ${input.identity.projectionKind},
          ${input.identity.datasetVersion.datasetId},
          ${input.identity.datasetVersion.versionId},
          ${"objectTypeId" in input.target ? input.target.objectTypeId : null},
          ${"sourceObjectTypeId" in input.target ? input.target.sourceObjectTypeId : null},
          ${"sourceObjectTypeId" in input.target ? input.target.targetObjectTypeId : null},
          ${"running"},
          ${input.startedAt ?? new Date()},
          ${1},
          ${executionToken},
          ${input.identity.protocol},
          ${input.identity.datasetVersion.createdAt},
          ${input.identity.ontologyRevision},
          ${input.identity.projectionRevision},
          ${input.identity.ownershipHash},
          ${input.fixedBatchSize ?? null},
          ${input.fixedBatchSize === undefined ? null : 0},
          ${input.fixedBatchSize === undefined ? null : 0},
          ${input.fixedBatchSize === undefined ? null : false}
        )
        RETURNING *
      `

      return projectionRunClaim(inserted)
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
          error_message = ${plan.errorMessage ?? null}
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
  assertProjectionRunExecution(restoreProjectionRunRow(row), input)
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
    errorMessage: row.error_message ?? undefined,
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
  projection_id: string
  projection_kind: ProjectionKind
  dataset_id: string
  dataset_version_id: string
  object_type_id: string | null
  source_object_type_id: string | null
  target_object_type_id: string | null
  status: ProjectionRunStatus
  started_at: Date | string
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
  error_message: string | null
}
