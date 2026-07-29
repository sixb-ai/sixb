import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesPoint,
  TimeseriesStorage,
} from "@sixb/core/storage"
import type { SqlParameter } from "./pg-client"
import type { PgStoreClient } from "./transactions"

/**
 * PostgreSQL-based TimeseriesStorage implementation.
 *
 * Stores time-series data with JSONB values and TIMESTAMPTZ timestamps
 * for efficient querying of history and latest values.
 *
 * Requires `search_path` to be set to the Sixb schema on the connection.
 */
export class PgTimeseriesStorage implements TimeseriesStorage {
  constructor(private readonly sql: PgStoreClient) {}

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
    const order = params.order ?? "asc"

    // Build WHERE conditions using conditional fragments
    const fromFilter = params.from ? this.sql`AND at >= ${params.from}` : this.sql``
    const toFilter = params.to ? this.sql`AND at <= ${params.to}` : this.sql``
    const limitFilter = params.limit !== undefined ? this.sql`LIMIT ${params.limit}` : this.sql``

    const rows = await this.sql<TimeseriesDatabaseRow[]>`
      SELECT * FROM timeseries
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND object_id = ${params.objectId}
        AND property_id = ${params.propertyId}
        ${fromFilter}
        ${toFilter}
      ORDER BY at ${order === "asc" ? this.sql`ASC` : this.sql`DESC`}
      ${limitFilter}
    `

    return rows.map((row) => rowToPoint(row))
  }

  async getHistoryBatch(
    input: TimeseriesHistoryBatchInput
  ): Promise<readonly TimeseriesHistoryBatchResult[]> {
    if (input.series.length === 0) {
      return []
    }

    const order = input.order === "desc" ? "DESC" : "ASC"
    const params: unknown[] = []
    let nextIndex = 1
    const values = input.series
      .map((series, seriesIndex) => {
        const placeholders = [
          `$${nextIndex++}`,
          `$${nextIndex++}`,
          `$${nextIndex++}`,
          `$${nextIndex++}`,
        ]
        params.push(seriesIndex, series.objectTypeId, series.objectId, series.propertyId)
        return `(${placeholders.join(", ")})`
      })
      .join(", ")

    const projectIdPlaceholder = `$${nextIndex++}`
    params.push(input.projectId)

    const whereClauses = ["1 = 1"]
    if (input.from) {
      whereClauses.push(`timeseries.at >= $${nextIndex++}`)
      params.push(input.from)
    }
    if (input.to) {
      whereClauses.push(`timeseries.at <= $${nextIndex++}`)
      params.push(input.to)
    }

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
          ON timeseries.project_id = ${projectIdPlaceholder}
         AND timeseries.object_type_id = requested.object_type_id
         AND timeseries.object_id = requested.object_id
         AND timeseries.property_id = requested.property_id
        WHERE ${whereClauses.join(" AND ")}
      )
      SELECT * FROM ranked
    `

    if (input.limitPerSeries !== undefined) {
      query += ` WHERE series_row_number <= $${nextIndex++}`
      params.push(Math.max(0, input.limitPerSeries))
    }

    query += ` ORDER BY series_index ASC, at ${order}`

    const rows = await this.sql.unsafe<
      (TimeseriesDatabaseRow & {
        series_index: number | string
        series_row_number: number | string
      })[]
    >(query, params as SqlParameter[])
    const results = input.series.map((series) => ({
      ...series,
      points: [] as TimeseriesPoint[],
    }))

    for (const row of rows) {
      const result = results[Number(row.series_index)]
      if (result) {
        result.points.push(rowToPoint(row))
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
    const [row] = await this.sql<TimeseriesDatabaseRow[]>`
      SELECT * FROM timeseries_latest
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND object_id = ${params.objectId}
        AND property_id = ${params.propertyId}
    `

    return row ? rowToPoint(row) : null
  }
}

function rowToPoint(row: TimeseriesDatabaseRow): TimeseriesPoint {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    objectId: row.object_id,
    propertyId: row.property_id,
    value: row.value,
    unit: row.unit ?? undefined,
    at: new Date(row.at),
    lastCommitId: row.last_commit_id,
  }
}

interface TimeseriesDatabaseRow {
  project_id: string
  object_type_id: string
  object_id: string
  property_id: string
  value: unknown
  unit: string | null
  at: Date | string
  last_commit_id: string
}
