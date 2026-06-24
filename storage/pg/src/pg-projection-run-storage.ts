import type {
  FinishProjectionRunInput,
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionKind,
  ProjectionRunCounters,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  StartProjectionRunInput,
  UpdateProjectionRunInput,
} from "@sixb/core"
import { PROJECTION_COUNTER_KEYS, ProjectionRunError } from "@sixb/core"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SQLClient, SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgProjectionRunStorage implements ProjectionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

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
          started_at,
          rows_processed,
          rows_skipped,
          objects_upserted,
          links_upserted,
          telemetry_points_appended,
          telemetry_points_skipped,
          telemetry_rows_failed
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
          ${input.startedAt ?? new Date()},
          ${0},
          ${0},
          ${0},
          ${0},
          ${0},
          ${0},
          ${0}
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
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToProjectionRunRecord(updated)
    })
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await requireRunning(tx, input.projectId, input.id)
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
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

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
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
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
      // A run is visible when every object type it targets is viewable: the
      // single object type for object/telemetry runs, or both ends for links.
      // An empty viewable set matches no runs.
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

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
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

  if (row.status !== "running") {
    throw new ProjectionRunError(
      `[SixbPg] Projection run '${id}' for project '${projectId}' is already terminal.`
    )
  }

  return row
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
    rowsProcessed: Number(row.rows_processed),
    rowsSkipped: Number(row.rows_skipped),
    objectsUpserted: Number(row.objects_upserted),
    linksUpserted: Number(row.links_upserted),
    telemetryPointsAppended: Number(row.telemetry_points_appended),
    telemetryPointsSkipped: Number(row.telemetry_points_skipped),
    telemetryRowsFailed: Number(row.telemetry_rows_failed),
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
    ...rowToCounters(row),
    errorMessage: row.error_message ?? undefined,
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProjectionRunError(`[SixbPg] Projection run ${fieldName} must not be empty.`)
  }
}

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProjectionRunError(
      `[SixbPg] Projection run ${fieldName} must be a non-negative integer.`
    )
  }
}

function assertOptionalCounter(value: number | undefined, fieldName: string): void {
  if (value !== undefined) {
    assertCounter(value, fieldName)
  }
}

function assertOptionalWindowValue(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new ProjectionRunError(`[SixbPg] Projection run list ${fieldName} must be >= 0.`)
  }
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
  rows_processed: number | string
  rows_skipped: number | string
  objects_upserted: number | string
  links_upserted: number | string
  telemetry_points_appended: number | string
  telemetry_points_skipped: number | string
  telemetry_rows_failed: number | string
  error_message: string | null
}
