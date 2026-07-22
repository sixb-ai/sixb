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
  ProjectionMaterializationIdentity,
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
import type { SQLClient, SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

type StoredProjectionRunRecord = ProjectionRunRecord & { readonly executionToken?: string }

export class PgProjectionRunStorage implements ProjectionMaterializationRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async startOrReclaimMaterialization(
    input: StartOrReclaimProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    assertNonEmpty(input.id, "id")
    assertNonEmpty(input.projectId, "projectId")
    assertIdentity(input.identity)
    assertObjectTypes(input.identity.projectionKind, input)
    if (input.identity.protocol === "telemetry") {
      assertPositiveCounter(input.fixedBatchSize ?? 0, "fixedBatchSize")
    } else if (input.fixedBatchSize !== undefined) {
      throw new ProjectionRunError(
        "[SixbPg] Replacement projection runs cannot declare a telemetry fixedBatchSize."
      )
    }

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
        throw new ProjectionRunError(
          `[SixbPg] Dataset version '${input.identity.datasetVersion.versionId}' reused an immutable dataset version id with different metadata.`
        )
      }

      const [existingRow] = await tx<DatabaseRow[]>`
        SELECT * FROM projection_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      const existing = existingRow ? rowToStoredProjectionRunRecord(existingRow) : undefined
      const executionToken = createFreshExecutionToken(existing?.executionToken)

      if (existingRow && existing) {
        assertRunning(existing)
        assertMaterializationIdentityMatches(existing, input.identity)
        assertObjectTypesMatch(existing, input)
        if (existing.telemetryCheckpoint?.fixedBatchSize !== input.fixedBatchSize) {
          throw new ProjectionRunError(
            `[SixbPg] Projection run '${input.id}' fixed batch size does not match.`
          )
        }
        assertCompleteMaterializationRecord(existing)
        const attempt = safeAdd(existing.attempt, 1, "attempt")

        const [updated] = await tx<DatabaseRow[]>`
          UPDATE projection_runs
          SET attempt = ${attempt}, execution_token = ${executionToken}
          WHERE project_id = ${input.projectId}
            AND id = ${input.id}
            AND status = ${"running"}
            AND execution_token = ${existing.executionToken}
          RETURNING *
        `
        if (!updated) throw staleExecutionToken(input.id)
        return rowToMaterializationRunRecord(updated)
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
          ${input.objectTypeId ?? null},
          ${input.sourceObjectTypeId ?? null},
          ${input.targetObjectTypeId ?? null},
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

      return rowToMaterializationRunRecord(inserted)
    })
  }

  async assertMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await requireMaterializationExecution(tx, input)
      return rowToMaterializationRunRecord(row)
    })
  }

  async updateMaterialization(
    input: UpdateProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await requireMaterializationExecution(tx, input)
      const counters = mergeCounters(rowToCounters(existing), input)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          rows_processed = ${counters.rowsProcessed},
          rows_skipped = ${counters.rowsSkipped},
          objects_upserted = ${counters.objectsUpserted},
          links_upserted = ${counters.linksUpserted},
          telemetry_points_appended = ${counters.telemetryPointsAppended},
          telemetry_points_skipped = ${counters.telemetryPointsSkipped},
          telemetry_rows_failed = ${counters.telemetryRowsFailed}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
        RETURNING *
      `
      if (!updated) throw staleExecutionToken(input.id)
      return rowToMaterializationRunRecord(updated)
    })
  }

  async finishMaterialization(
    input: FinishProjectionMaterializationInput
  ): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = rowToMaterializationRunRecord(existingRow)
      if (
        input.status === "succeeded" &&
        existing.materializationProtocol === "telemetry" &&
        !existing.telemetryCheckpoint?.inputExhausted
      ) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' cannot succeed before its input is exhausted.`
        )
      }
      const counters = mergeCounters(rowToCounters(existingRow), input)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          status = ${input.status},
          finished_at = ${input.finishedAt ?? new Date()},
          execution_token = ${null},
          rows_processed = ${counters.rowsProcessed},
          rows_skipped = ${counters.rowsSkipped},
          objects_upserted = ${counters.objectsUpserted},
          links_upserted = ${counters.linksUpserted},
          telemetry_points_appended = ${counters.telemetryPointsAppended},
          telemetry_points_skipped = ${counters.telemetryPointsSkipped},
          telemetry_rows_failed = ${counters.telemetryRowsFailed},
          error_message = ${input.status === "succeeded" ? null : (input.errorMessage ?? null)}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
        RETURNING *
      `
      if (!updated) throw staleExecutionToken(input.id)
      return rowToProjectionRunRecord(updated)
    })
  }

  async advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = rowToMaterializationRunRecord(existingRow)
      if (existing.materializationProtocol !== "telemetry") {
        throw new ProjectionRunError(
          `[SixbPg] Projection run '${existing.id}' does not have a telemetry checkpoint.`
        )
      }
      const checkpoint = existing.telemetryCheckpoint
      if (!checkpoint) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' has incomplete checkpoint state.`
        )
      }
      assertCounter(input.batchOrdinal, "batchOrdinal")
      assertPositiveCounter(input.batchRowCount, "batchRowCount")
      if (input.batchOrdinal !== checkpoint.nextBatchOrdinal) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' expected batch ordinal ${checkpoint.nextBatchOrdinal}, got ${input.batchOrdinal}.`
        )
      }
      if (input.batchRowCount > checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' batch exceeds its fixed size.`
        )
      }
      if (!input.inputExhausted && input.batchRowCount !== checkpoint.fixedBatchSize) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' cannot advance past a partial non-final batch.`
        )
      }
      if (checkpoint.inputExhausted) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' has already exhausted its input.`
        )
      }

      const nextBatchOrdinal = safeAdd(checkpoint.nextBatchOrdinal, 1, "nextBatchOrdinal")
      const nextRowOffset = safeAdd(checkpoint.nextRowOffset, input.batchRowCount, "nextRowOffset")
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          next_batch_ordinal = ${nextBatchOrdinal},
          next_row_offset = ${nextRowOffset},
          input_exhausted = ${input.inputExhausted}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
          AND next_batch_ordinal = ${input.batchOrdinal}
          AND input_exhausted = ${false}
        RETURNING *
      `
      if (!updated) throw staleExecutionToken(input.id)
      return rowToMaterializationRunRecord(updated)
    })
  }

  async completeEmptyTelemetryInput(
    input: CompleteEmptyProjectionTelemetryInput
  ): Promise<ProjectionMaterializationRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = rowToMaterializationRunRecord(existingRow)
      const checkpoint = existing.telemetryCheckpoint
      if (existing.materializationProtocol !== "telemetry" || !checkpoint) {
        throw new ProjectionRunError(
          `[SixbPg] Projection run '${existing.id}' does not have a telemetry checkpoint.`
        )
      }
      if (
        checkpoint.nextBatchOrdinal !== 0 ||
        checkpoint.nextRowOffset !== 0 ||
        checkpoint.inputExhausted
      ) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' cannot declare empty input after progress.`
        )
      }

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET input_exhausted = ${true}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
          AND next_batch_ordinal = ${0}
          AND next_row_offset = ${0}
          AND input_exhausted = ${false}
        RETURNING *
      `
      if (!updated) throw staleExecutionToken(input.id)
      return rowToMaterializationRunRecord(updated)
    })
  }

  async start(input: StartProjectionRunInput): Promise<ProjectionRunRecord> {
    assertNonEmpty(input.id, "id")
    assertNonEmpty(input.projectId, "projectId")
    assertNonEmpty(input.projectionId, "projectionId")
    assertNonEmpty(input.datasetId, "datasetId")
    assertNonEmpty(input.datasetVersionId, "datasetVersionId")

    try {
      const [row] = await this.sql<DatabaseRow[]>`
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
          started_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.projectionId},
          ${input.projectionKind},
          ${input.datasetId},
          ${input.datasetVersionId},
          ${input.objectTypeId ?? null},
          ${input.sourceObjectTypeId ?? null},
          ${input.targetObjectTypeId ?? null},
          ${"running"},
          ${input.startedAt ?? new Date()}
        )
        RETURNING *
      `

      return rowToProjectionRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectionRunError(
          `[SixbPg] Projection run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      throw error
    }
  }

  async update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await requireRunning(tx, input.projectId, input.id)
      assertLegacyMutationAllowed(rowToStoredProjectionRunRecord(existing), "update")
      const counters = mergeCounters(rowToCounters(existing), input)

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          rows_processed = ${counters.rowsProcessed},
          rows_skipped = ${counters.rowsSkipped},
          objects_upserted = ${counters.objectsUpserted},
          links_upserted = ${counters.linksUpserted},
          telemetry_points_appended = ${counters.telemetryPointsAppended},
          telemetry_points_skipped = ${counters.telemetryPointsSkipped},
          telemetry_rows_failed = ${counters.telemetryRowsFailed}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND materialization_protocol IS NULL
        RETURNING *
      `
      if (!updated) throw invalidLegacyTransition(input.id, "update")
      return rowToProjectionRunRecord(updated)
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await requireRunning(tx, input.projectId, input.id)
      assertLegacyMutationAllowed(rowToStoredProjectionRunRecord(existing), "finish")
      const counters = mergeCounters(rowToCounters(existing), input)

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          status = ${input.status},
          finished_at = ${input.finishedAt ?? new Date()},
          rows_processed = ${counters.rowsProcessed},
          rows_skipped = ${counters.rowsSkipped},
          objects_upserted = ${counters.objectsUpserted},
          links_upserted = ${counters.linksUpserted},
          telemetry_points_appended = ${counters.telemetryPointsAppended},
          telemetry_points_skipped = ${counters.telemetryPointsSkipped},
          telemetry_rows_failed = ${counters.telemetryRowsFailed},
          error_message = ${input.status === "succeeded" ? null : (input.errorMessage ?? null)}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND materialization_protocol IS NULL
        RETURNING *
      `
      if (!updated) throw invalidLegacyTransition(input.id, "finish")
      return rowToProjectionRunRecord(updated)
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
    assertNonEmpty(input.projectId, "projectId")

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
    assertOptionalWindowValue(input.limit, "limit")
    assertOptionalWindowValue(offset, "offset")

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
  input: AssertProjectionMaterializationExecutionInput
): Promise<DatabaseRow> {
  assertNonEmpty(input.executionToken, "executionToken")
  assertIdentity(input.identity)
  const row = await requireRunning(sql, input.projectId, input.id)
  const record = rowToStoredProjectionRunRecord(row)
  assertMaterializationIdentityMatches(record, input.identity)
  if (!record.executionToken || record.executionToken !== input.executionToken) {
    throw staleExecutionToken(input.id)
  }
  assertCompleteMaterializationRecord(record)
  return row
}

async function requireRunning(sql: SQLClient, projectId: string, id: string): Promise<DatabaseRow> {
  assertNonEmpty(projectId, "projectId")
  assertNonEmpty(id, "id")

  const [row] = await sql<DatabaseRow[]>`
    SELECT * FROM projection_runs
    WHERE project_id = ${projectId} AND id = ${id}
    FOR UPDATE
  `
  if (!row) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${id}' not found for project '${projectId}'.`
    )
  }
  assertRunning(rowToStoredProjectionRunRecord(row))
  return row
}

function assertRunning(record: ProjectionRunRecord): void {
  if (record.status !== "running") {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' for project '${record.projectId}' is already terminal.`
    )
  }
}

function assertLegacyMutationAllowed(
  record: ProjectionRunRecord,
  operation: "update" | "finish"
): void {
  if (record.materializationProtocol !== undefined) {
    throw invalidLegacyTransition(record.id, operation)
  }
}

function invalidLegacyTransition(id: string, operation: "update" | "finish"): ProjectionRunError {
  return new ProjectionRunError(
    `[SixbPg] Projection materialization run '${id}' cannot use legacy ${operation}(); use ${operation}Materialization() with the current execution token.`
  )
}

function staleExecutionToken(id: string): ProjectionRunError {
  return new ProjectionRunError(
    `[SixbPg] Projection run '${id}' execution token is stale.`,
    "execution-lost"
  )
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

function assertIdentity(identity: ProjectionMaterializationIdentity): void {
  assertNonEmpty(identity.projectionId, "projectionId")
  if (
    identity.projectionKind !== "object" &&
    identity.projectionKind !== "link" &&
    identity.projectionKind !== "telemetry"
  ) {
    throw new ProjectionRunError(
      "[SixbPg] Projection run projectionKind must be 'object', 'link', or 'telemetry'."
    )
  }
  if (identity.protocol !== "replacement" && identity.protocol !== "telemetry") {
    throw new ProjectionRunError(
      "[SixbPg] Projection run protocol must be 'replacement' or 'telemetry'."
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
      `[SixbPg] Projection run protocol '${identity.protocol}' is incompatible with kind '${identity.projectionKind}'.`
    )
  }
}

function assertObjectTypes(kind: ProjectionKind, input: ProjectionRunObjectTypes): void {
  if (kind === "link") {
    assertNonEmpty(input.sourceObjectTypeId ?? "", "sourceObjectTypeId")
    assertNonEmpty(input.targetObjectTypeId ?? "", "targetObjectTypeId")
    if (input.objectTypeId !== undefined) {
      throw new ProjectionRunError(
        "[SixbPg] Link projection runs cannot declare a singular objectTypeId."
      )
    }
    return
  }
  assertNonEmpty(input.objectTypeId ?? "", "objectTypeId")
  if (input.sourceObjectTypeId !== undefined || input.targetObjectTypeId !== undefined) {
    throw new ProjectionRunError(
      "[SixbPg] Object and telemetry projection runs cannot declare link endpoint types."
    )
  }
}

function assertMaterializationIdentityMatches(
  record: ProjectionRunRecord,
  identity: ProjectionMaterializationIdentity
): void {
  if (
    record.projectionId !== identity.projectionId ||
    record.projectionKind !== identity.projectionKind ||
    record.materializationProtocol !== identity.protocol ||
    record.datasetId !== identity.datasetVersion.datasetId ||
    record.datasetVersionId !== identity.datasetVersion.versionId ||
    record.datasetVersionCreatedAt !== identity.datasetVersion.createdAt ||
    record.ontologyRevision !== identity.ontologyRevision ||
    record.projectionRevision !== identity.projectionRevision ||
    record.ownershipHash !== identity.ownershipHash
  ) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' materialization identity does not match.`
    )
  }
}

function assertObjectTypesMatch(
  record: ProjectionRunRecord,
  input: ProjectionRunObjectTypes
): void {
  if (
    record.objectTypeId !== input.objectTypeId ||
    record.sourceObjectTypeId !== input.sourceObjectTypeId ||
    record.targetObjectTypeId !== input.targetObjectTypeId
  ) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' target object types do not match.`
    )
  }
}

function assertCompleteMaterializationRecord(
  record: StoredProjectionRunRecord
): asserts record is ProjectionMaterializationRunRecord {
  if (
    record.attempt === undefined ||
    record.attempt < 1 ||
    !record.executionToken ||
    !record.materializationProtocol ||
    !record.datasetVersionCreatedAt ||
    !record.ontologyRevision ||
    !record.projectionRevision ||
    !record.ownershipHash
  ) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' has incomplete materialization state.`
    )
  }
  if (record.materializationProtocol === "telemetry" && !record.telemetryCheckpoint) {
    throw new ProjectionRunError(
      `[SixbPg] Telemetry projection run '${record.id}' has incomplete checkpoint state.`
    )
  }
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

function rowToProjectionRunRecord(row: DatabaseRow): ProjectionRunRecord {
  const { executionToken: _, ...record } = rowToStoredProjectionRunRecord(row)
  return record
}

function rowToMaterializationRunRecord(row: DatabaseRow): ProjectionMaterializationRunRecord {
  const record = rowToStoredProjectionRunRecord(row)
  assertCompleteMaterializationRecord(record)
  return record
}

function rowToStoredProjectionRunRecord(row: DatabaseRow): StoredProjectionRunRecord {
  const telemetryCheckpoint = checkpointFromRow(row)

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
    executionToken: row.execution_token ?? undefined,
    materializationProtocol: row.materialization_protocol ?? undefined,
    datasetVersionCreatedAt: row.dataset_version_created_at ?? undefined,
    ontologyRevision: row.ontology_revision ?? undefined,
    projectionRevision: row.projection_revision ?? undefined,
    ownershipHash: row.ownership_hash ?? undefined,
    telemetryCheckpoint,
    ...rowToCounters(row),
    errorMessage: row.error_message ?? undefined,
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
    inputExhausted: row.input_exhausted,
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionRunError(`[SixbPg] Projection run ${fieldName} must not be empty.`)
  }
}

function assertCanonicalTimestamp(value: string, fieldName: string): void {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run ${fieldName} must be a canonical UTC timestamp.`
    )
  }
}

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run ${fieldName} must be a non-negative safe integer.`
    )
  }
}

function assertPositiveCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run ${fieldName} must be a positive safe integer.`
    )
  }
}

function assertOptionalCounter(value: number | undefined, fieldName: string): void {
  if (value !== undefined) assertCounter(value, fieldName)
}

function assertOptionalWindowValue(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ProjectionRunError(`[SixbPg] Projection run list ${fieldName} must be >= 0.`)
  }
}

function safeAdd(left: number, right: number, fieldName: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new ProjectionRunError(`[SixbPg] Projection run ${fieldName} exceeds safe integer range.`)
  }
  return result
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
  rows_processed: number | string
  rows_skipped: number | string
  objects_upserted: number | string
  links_upserted: number | string
  telemetry_points_appended: number | string
  telemetry_points_skipped: number | string
  telemetry_rows_failed: number | string
  error_message: string | null
}
