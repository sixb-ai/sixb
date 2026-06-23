import type { Database } from "bun:sqlite"
import type {
  FinishProjectionRunInput,
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
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"
import {
  assertOptionalProjectionRunCounter,
  assertProjectionRunFieldNonEmpty,
  assertProjectionRunListWindowValue,
} from "./validation"

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

  async start(input: StartProjectionRunInput): Promise<ProjectionRunRecord> {
    assertProjectionRunFieldNonEmpty(input.id, "id")
    assertProjectionRunFieldNonEmpty(input.projectId, "projectId")
    assertProjectionRunFieldNonEmpty(input.projectionId, "projectionId")
    assertProjectionRunFieldNonEmpty(input.datasetId, "datasetId")
    assertProjectionRunFieldNonEmpty(input.datasetVersionId, "datasetVersionId")

    const startedAt = input.startedAt ?? new Date()

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
            status,
            started_at,
            rows_processed,
            rows_skipped,
            objects_upserted,
            links_upserted,
            telemetry_points_appended,
            telemetry_points_skipped,
            telemetry_rows_failed
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, 0, 0, 0, 0)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.projectionId,
          input.projectionKind,
          input.datasetId,
          input.datasetVersionId,
          startedAt.toISOString()
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
    return this.db.transaction(() => {
      const existing = this.requireRunning(input.projectId, input.id)
      const counters = mergeCounters(rowToCounters(existing), input)

      this.db
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
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          counters.rowsProcessed,
          counters.rowsSkipped,
          counters.objectsUpserted,
          counters.linksUpserted,
          counters.telemetryPointsAppended,
          counters.telemetryPointsSkipped,
          counters.telemetryRowsFailed,
          input.projectId,
          input.id
        )

      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })()
  }

  async finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.requireRunning(input.projectId, input.id)
      const counters = mergeCounters(rowToCounters(existing), input)

      this.db
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
          WHERE project_id = ? AND id = ?
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

      return rowToProjectionRunRecord(this.requireRow(input.projectId, input.id))
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM projection_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as DatabaseRow | null

    return row ? rowToProjectionRunRecord(row) : null
  }

  async list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult> {
    assertProjectionRunFieldNonEmpty(input.projectId, "projectId")

    if (input.statuses && input.statuses.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
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
      assertProjectionRunListWindowValue(limit, "limit")
      assertProjectionRunListWindowValue(offset, "offset")
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      assertProjectionRunListWindowValue(offset, "offset")
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as DatabaseRow[]
    const runs = rows.map(rowToProjectionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < totalRow.count,
      total: totalRow.count,
    }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private requireRunning(projectId: string, id: string): DatabaseRow {
    const row = this.requireRow(projectId, id)
    if (row.status !== "running") {
      throw new ProjectionRunError(
        `[SixbSqlite] Projection run '${id}' for project '${projectId}' is already terminal.`
      )
    }
    return row
  }

  private requireRow(projectId: string, id: string): DatabaseRow {
    assertProjectionRunFieldNonEmpty(projectId, "projectId")
    assertProjectionRunFieldNonEmpty(id, "id")

    const row = this.db
      .query("SELECT * FROM projection_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as DatabaseRow | null

    if (!row) {
      throw new ProjectionRunError(
        `[SixbSqlite] Projection run '${id}' not found for project '${projectId}'.`
      )
    }

    return row
  }
}

function mergeCounters(
  existing: ProjectionRunCounters,
  input: Partial<ProjectionRunCounters>
): ProjectionRunCounters {
  const merged = {} as Record<keyof ProjectionRunCounters, number>
  for (const key of PROJECTION_COUNTER_KEYS) {
    assertOptionalProjectionRunCounter(input[key], key)
    merged[key] = input[key] ?? existing[key]
  }
  return merged
}

function rowToCounters(row: DatabaseRow): ProjectionRunCounters {
  return {
    rowsProcessed: row.rows_processed,
    rowsSkipped: row.rows_skipped,
    objectsUpserted: row.objects_upserted,
    linksUpserted: row.links_upserted,
    telemetryPointsAppended: row.telemetry_points_appended,
    telemetryPointsSkipped: row.telemetry_points_skipped,
    telemetryRowsFailed: row.telemetry_rows_failed,
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
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    rowsProcessed: row.rows_processed,
    rowsSkipped: row.rows_skipped,
    objectsUpserted: row.objects_upserted,
    linksUpserted: row.links_upserted,
    telemetryPointsAppended: row.telemetry_points_appended,
    telemetryPointsSkipped: row.telemetry_points_skipped,
    telemetryRowsFailed: row.telemetry_rows_failed,
    errorMessage: row.error_message ?? undefined,
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

interface DatabaseRow {
  project_id: string
  id: string
  projection_id: string
  projection_kind: ProjectionKind
  dataset_id: string
  dataset_version_id: string
  status: ProjectionRunStatus
  started_at: string
  finished_at: string | null
  rows_processed: number
  rows_skipped: number
  objects_upserted: number
  links_upserted: number
  telemetry_points_appended: number
  telemetry_points_skipped: number
  telemetry_rows_failed: number
  error_message: string | null
}
