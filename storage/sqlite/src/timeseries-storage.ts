import type { Database } from "bun:sqlite"
import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesPoint,
  TimeseriesStorage,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteTimeseriesStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

/**
 * SQLite-based TimeseriesStorage implementation.
 *
 * Stores time-series data with efficient querying for history and latest values.
 */
export class SqliteTimeseriesStorage implements TimeseriesStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteTimeseriesStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async getHistory(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
    from?: Date
    to?: Date
    limit?: number
    order?: "asc" | "desc"
  }): Promise<readonly TimeseriesPoint[]> {
    let query = `
      SELECT * FROM timeseries
      WHERE project_id = ? AND object_type_id = ? AND object_id = ? AND property_id = ?
    `
    const args: (string | number | null)[] = [
      params.projectId,
      params.objectTypeId,
      params.objectId,
      params.propertyId,
    ]

    if (params.from) {
      query += " AND at >= ?"
      args.push(params.from.toISOString())
    }

    if (params.to) {
      query += " AND at <= ?"
      args.push(params.to.toISOString())
    }

    query += ` ORDER BY at ${params.order === "desc" ? "DESC" : "ASC"}`

    if (params.limit !== undefined) {
      query += " LIMIT ?"
      args.push(params.limit)
    }

    const rows = this.db.query(query).all(...args) as DatabaseRow[]

    return rows.map((row) => this.rowToPoint(row))
  }

  async getHistoryBatch(
    input: TimeseriesHistoryBatchInput
  ): Promise<readonly TimeseriesHistoryBatchResult[]> {
    if (input.series.length === 0) {
      return []
    }

    const order = input.order === "desc" ? "DESC" : "ASC"
    const values = input.series.map(() => "(?, ?, ?, ?)").join(", ")
    const args: (string | number | null)[] = []

    input.series.forEach((series, index) => {
      args.push(index, series.objectTypeId, series.objectId, series.propertyId)
    })

    let query = `
      WITH requested(series_index, object_type_id, object_id, property_id) AS (
        VALUES ${values}
      ),
      ranked AS (
        SELECT
          requested.series_index,
          timeseries.*,
          ROW_NUMBER() OVER (
            PARTITION BY requested.series_index
            ORDER BY timeseries.at ${order}
          ) AS series_row_number
        FROM requested
        JOIN timeseries
          ON timeseries.project_id = ?
         AND timeseries.object_type_id = requested.object_type_id
         AND timeseries.object_id = requested.object_id
         AND timeseries.property_id = requested.property_id
        WHERE 1 = 1
    `
    args.push(input.projectId)

    if (input.from) {
      query += " AND timeseries.at >= ?"
      args.push(input.from.toISOString())
    }

    if (input.to) {
      query += " AND timeseries.at <= ?"
      args.push(input.to.toISOString())
    }

    query += "\n      )\n      SELECT * FROM ranked"

    if (input.limitPerSeries !== undefined) {
      query += " WHERE series_row_number <= ?"
      args.push(Math.max(0, input.limitPerSeries))
    }

    query += ` ORDER BY series_index ASC, at ${order}`

    const rows = this.db.query(query).all(...args) as (DatabaseRow & {
      series_index: number
      series_row_number: number
    })[]
    const results = input.series.map((series) => ({
      ...series,
      points: [] as TimeseriesPoint[],
    }))

    for (const row of rows) {
      const result = results[row.series_index]
      if (result) {
        result.points.push(this.rowToPoint(row))
      }
    }

    return results
  }

  async getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null> {
    const row = this.db
      .query(
        `
        SELECT * FROM timeseries
        WHERE project_id = ? AND object_type_id = ? AND object_id = ? AND property_id = ?
        ORDER BY at DESC
        LIMIT 1
      `
      )
      .get(
        params.projectId,
        params.objectTypeId,
        params.objectId,
        params.propertyId
      ) as DatabaseRow | null

    return row ? this.rowToPoint(row) : null
  }
  private rowToPoint(row: DatabaseRow): TimeseriesPoint {
    return {
      projectId: row.project_id,
      objectTypeId: row.object_type_id,
      objectId: row.object_id,
      propertyId: row.property_id,
      value: JSON.parse(row.value),
      unit: row.unit ?? undefined,
      at: new Date(row.at),
      lastCommitId: row.last_commit_id,
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}

interface DatabaseRow {
  project_id: string
  object_type_id: string
  object_id: string
  property_id: string
  value: string
  unit: string | null
  at: string
  last_commit_id: string
}
