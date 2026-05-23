import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { StoredTelemetryAppendedEvent, TimeseriesPoint, TimeseriesStorage } from "@sixb/core"
import { installFreshSqliteSchema } from "./migrations"

export interface SqliteTimeseriesStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

/**
 * SQLite-based TimeseriesStorage implementation.
 *
 * Stores time-series data with efficient querying for history and latest values.
 */
export class SqliteTimeseriesStorage implements TimeseriesStorage {
  private readonly db: Database

  constructor(options: SqliteTimeseriesStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
      installFreshSqliteSchema(this.db)
    }
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    // Check idempotency
    const applied = this.db
      .query("SELECT 1 FROM applied_events_timeseries WHERE event_id = ?")
      .get(event.id)

    if (applied) return

    this.db
      .query(
        `
        INSERT INTO timeseries (
          project_id, object_type_id, object_id, property_id,
          value, unit, at, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        event.projectId,
        event.payload.objectTypeId,
        event.payload.objectId,
        event.payload.propertyId,
        JSON.stringify(event.payload.value),
        event.payload.unit ?? null,
        event.payload.at,
        event.id
      )

    this.db
      .query("INSERT OR IGNORE INTO applied_events_timeseries (event_id) VALUES (?)")
      .run(event.id)
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    if (events.length === 0) return

    this.db.transaction(() => {
      const checkApplied = this.db.query(
        "SELECT 1 FROM applied_events_timeseries WHERE event_id = ?"
      )
      const insertPoint = this.db.query(`
        INSERT INTO timeseries (
          project_id, object_type_id, object_id, property_id,
          value, unit, at, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const markApplied = this.db.query(
        "INSERT OR IGNORE INTO applied_events_timeseries (event_id) VALUES (?)"
      )

      for (const event of events) {
        if (checkApplied.get(event.id)) continue

        insertPoint.run(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.objectId,
          event.payload.propertyId,
          JSON.stringify(event.payload.value),
          event.payload.unit ?? null,
          event.payload.at,
          event.id
        )
        markApplied.run(event.id)
      }
    })()
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
        ORDER BY at DESC, source_event_id DESC
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
      sourceEventId: row.source_event_id ?? undefined,
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
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
  source_event_id: string | null
}
