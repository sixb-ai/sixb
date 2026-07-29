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
import type { SQLClient, SqlParameter } from "./pg-client"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

type StoredProjectionRunRecord = ProjectionRunRecord & { readonly executionToken?: string }

export class PgProjectionRunStorage implements ProjectionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim> {
    assertNonEmpty(input.id, "id")
    assertNonEmpty(input.projectId, "projectId")
    assertIdentity(input.identity)
    assertTarget(input.identity.projectionKind, input.target)
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
        assertTargetMatches(existing, input.target)
        if (existing.telemetryCheckpoint?.fixedBatchSize !== input.fixedBatchSize) {
          throw new ProjectionRunError(
            `[SixbPg] Projection run '${input.id}' fixed batch size does not match.`
          )
        }
        assertCompleteStoredRecord(existing)
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
      const existing = await requireMaterializationExecution(tx, input)
      const currentProgress = rowToProgress(existing)
      assertGenericProgressDoesNotAdvanceTelemetry(existing, currentProgress, input.progress)
      const progress = mergeProgress(currentProgress, input.progress)
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
      if (!updated) throw staleExecutionToken(input.id)
      return rowToProjectionRunRecord(updated)
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const currentProgress = rowToProgress(existingRow)
      const progressPatch = input.progress ?? {}
      assertGenericProgressDoesNotAdvanceTelemetry(existingRow, currentProgress, progressPatch)
      const progress = mergeProgress(currentProgress, progressPatch)
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          status = ${input.status},
          finished_at = ${input.finishedAt ?? new Date()},
          execution_token = ${null},
          source_rows_read = ${progress.sourceRowsRead},
          source_rows_skipped = ${progress.sourceRowsSkipped},
          input_exhausted = CASE
            WHEN materialization_protocol = 'telemetry' AND ${input.status} = 'succeeded' THEN TRUE
            ELSE input_exhausted
          END,
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
  ): Promise<TelemetryProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existingRow = await requireMaterializationExecution(tx, input)
      const existing = rowToProjectionRunRecord(existingRow)
      if (existing.identity.projectionKind !== "telemetry") {
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
      assertCounter(input.batchRowsSkipped, "batchRowsSkipped")
      if (input.batchRowsSkipped > input.batchRowCount) {
        throw new ProjectionRunError(
          `[SixbPg] Telemetry projection run '${existing.id}' skipped rows exceed its batch row count.`
        )
      }
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
      const nextRowsSkipped = safeAdd(
        existing.progress.sourceRowsSkipped,
        input.batchRowsSkipped,
        "sourceRowsSkipped"
      )
      const [updated] = await tx<DatabaseRow[]>`
        UPDATE projection_runs
        SET
          next_batch_ordinal = ${nextBatchOrdinal},
          next_row_offset = ${nextRowOffset},
          input_exhausted = ${input.inputExhausted},
          source_rows_read = ${nextRowOffset},
          source_rows_skipped = ${nextRowsSkipped}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
          AND status = ${"running"}
          AND execution_token = ${input.executionToken}
          AND next_batch_ordinal = ${input.batchOrdinal}
          AND input_exhausted = ${false}
        RETURNING *
      `
      if (!updated) throw staleExecutionToken(input.id)
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
  input: LockProjectionRunForMaterializationInput
): Promise<DatabaseRow> {
  assertNonEmpty(input.executionToken, "executionToken")
  assertIdentity(input.identity)
  const row = await requireRunning(sql, input.projectId, input.id)
  const record = rowToStoredProjectionRunRecord(row)
  assertMaterializationIdentityMatches(record, input.identity)
  if (!record.executionToken || record.executionToken !== input.executionToken) {
    throw staleExecutionToken(input.id)
  }
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

function assertTarget(
  kind: ProjectionKind,
  target: StartOrReclaimProjectionRunInput["target"]
): void {
  if (kind === "link") {
    if (!("sourceObjectTypeId" in target)) {
      throw new ProjectionRunError(
        "[SixbPg] Link projection runs must declare source and target object types."
      )
    }
    assertNonEmpty(target.sourceObjectTypeId, "sourceObjectTypeId")
    assertNonEmpty(target.targetObjectTypeId, "targetObjectTypeId")
    return
  }
  if (!("objectTypeId" in target)) {
    throw new ProjectionRunError(
      "[SixbPg] Object and telemetry projection runs must declare one object type."
    )
  }
  assertNonEmpty(target.objectTypeId, "objectTypeId")
}

function assertMaterializationIdentityMatches(
  record: ProjectionRunRecord,
  identity: ProjectionMaterializationIdentity
): void {
  if (
    record.identity.projectionId !== identity.projectionId ||
    record.identity.projectionKind !== identity.projectionKind ||
    record.identity.protocol !== identity.protocol ||
    record.identity.datasetVersion.datasetId !== identity.datasetVersion.datasetId ||
    record.identity.datasetVersion.versionId !== identity.datasetVersion.versionId ||
    record.identity.datasetVersion.createdAt !== identity.datasetVersion.createdAt ||
    record.identity.ontologyRevision !== identity.ontologyRevision ||
    record.identity.projectionRevision !== identity.projectionRevision ||
    record.identity.ownershipHash !== identity.ownershipHash
  ) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' materialization identity does not match.`
    )
  }
}

function assertTargetMatches(
  record: ProjectionRunRecord,
  target: StartOrReclaimProjectionRunInput["target"]
): void {
  const matches =
    "sourceObjectTypeId" in record.target || "sourceObjectTypeId" in target
      ? "sourceObjectTypeId" in record.target &&
        "sourceObjectTypeId" in target &&
        record.target.sourceObjectTypeId === target.sourceObjectTypeId &&
        record.target.targetObjectTypeId === target.targetObjectTypeId
      : record.target.objectTypeId === target.objectTypeId
  if (!matches) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' target object types do not match.`
    )
  }
}

function assertCompleteStoredRecord(
  record: StoredProjectionRunRecord
): asserts record is StoredProjectionRunRecord & { readonly executionToken: string } {
  if (record.attempt < 1 || !record.executionToken) {
    throw new ProjectionRunError(`[SixbPg] Projection run '${record.id}' has no active execution.`)
  }
  if (record.identity.projectionKind === "telemetry") {
    const checkpoint = record.telemetryCheckpoint
    if (!checkpoint) {
      throw new ProjectionRunError(
        `[SixbPg] Telemetry projection run '${record.id}' has incomplete checkpoint state.`
      )
    }
    if (record.progress.sourceRowsRead !== checkpoint.nextRowOffset) {
      throw new ProjectionRunError(
        `[SixbPg] Telemetry projection run '${record.id}' progress does not match its checkpoint.`
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
      throw new ProjectionRunError(`[SixbPg] Projection run ${key} must not decrease.`)
    }
    merged[key] = value
  }
  assertProgress(merged)
  return merged
}

function assertProgress(progress: ProjectionRunProgress): void {
  if (progress.sourceRowsSkipped > progress.sourceRowsRead) {
    throw new ProjectionRunError(
      "[SixbPg] Projection run sourceRowsSkipped must not exceed sourceRowsRead."
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
        `[SixbPg] Telemetry projection run '${row.id}' progress can only advance with its checkpoint.`
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

function rowToProjectionRunRecord(row: DatabaseRow): ProjectionRunRecord {
  const { executionToken: _, ...record } = rowToStoredProjectionRunRecord(row)
  return record
}

function projectionRunClaim(row: DatabaseRow): ProjectionRunClaim {
  const record = rowToStoredProjectionRunRecord(row)
  assertCompleteStoredRecord(record)
  return {
    run: rowToProjectionRunRecord(row),
    execution: { projectionRunId: record.id, executionToken: record.executionToken as string },
  }
}

function rowToTelemetryProjectionRunRecord(row: DatabaseRow): TelemetryProjectionRunRecord {
  const record = rowToProjectionRunRecord(row)
  if (record.identity.projectionKind !== "telemetry") {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${record.id}' does not have a telemetry checkpoint.`
    )
  }
  return record as TelemetryProjectionRunRecord
}

function rowToStoredProjectionRunRecord(row: DatabaseRow): StoredProjectionRunRecord {
  assertPersistedIdentity(row)
  const telemetryCheckpoint = checkpointFromRow(row)
  const base = {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    attempt: databaseSafeInteger(row.attempt, "attempt"),
    executionToken: row.execution_token ?? undefined,
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
  if (identity.projectionKind === "telemetry") {
    if (!telemetryCheckpoint) {
      throw new ProjectionRunError(
        `[SixbPg] Telemetry projection run '${row.id}' has incomplete checkpoint state.`
      )
    }
    return {
      ...base,
      identity,
      target: { objectTypeId: row.object_type_id },
      telemetryCheckpoint,
    }
  }
  if (telemetryCheckpoint) {
    throw new ProjectionRunError(
      `[SixbPg] Replacement projection run '${row.id}' contains a telemetry checkpoint.`
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

function assertPersistedIdentity(row: DatabaseRow): void {
  if (
    !row.materialization_protocol ||
    !row.dataset_version_created_at ||
    !row.ontology_revision ||
    !row.projection_revision ||
    !row.ownership_hash
  ) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${row.id}' has incomplete materialization identity.`
    )
  }
}

function invalidPersistedTarget(id: string): ProjectionRunError {
  return new ProjectionRunError(`[SixbPg] Projection run '${id}' has an invalid target.`)
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
  source_rows_read: number | string
  source_rows_skipped: number | string
  error_message: string | null
}
