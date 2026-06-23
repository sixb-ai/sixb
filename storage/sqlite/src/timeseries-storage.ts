import type { Database } from "bun:sqlite"
import type { StoredTelemetryAppendedEvent, TimeseriesPoint, TimeseriesStorage } from "@sixb/core"
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

// A telemetry point is uniquely identified by (series, at). Re-applying the
// same instant is a last-write-wins upsert, so telemetry writes are idempotent
// under replay without a separate dedup ledger.
const UPSERT_POINT_SQL = `
  INSERT INTO timeseries (
    project_id, object_type_id, object_id, property_id,
    value, unit, at, source_event_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (project_id, object_type_id, object_id, property_id, at)
  DO UPDATE SET
    value = excluded.value,
    unit = excluded.unit,
    source_event_id = excluded.source_event_id
`

function pointParams(
  event: StoredTelemetryAppendedEvent
): [string, string, string, string, string, string | null, string, string] {
  return [
    event.projectId,
    event.payload.objectTypeId,
    event.payload.objectId,
    event.payload.propertyId,
    JSON.stringify(event.payload.value),
    event.payload.unit ?? null,
    assertCanonicalUtcAt(event.payload.at),
    event.id,
  ]
}

// `at` is stored and compared as TEXT, so SQLite's lexicographic ordering and
// range scans match chronological order — and the (series, at) identity stays
// well-defined — only when every value is the canonical UTC ISO-8601 form that
// appendTelemetryBatch produces via Date.toISOString(). Enforce that invariant
// here so a writer that bypasses the normalization fails loudly instead of
// silently corrupting history queries. (pg needs no equivalent: TIMESTAMPTZ
// compares by instant regardless of textual form.)
function assertCanonicalUtcAt(at: string): string {
  const instant = new Date(at)
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== at) {
    throw new Error(
      `[SixbSqlite] Telemetry 'at' must be a canonical UTC ISO-8601 timestamp ` +
        `(e.g. "2026-06-21T10:00:00.000Z"), received "${at}".`
    )
  }
  return at
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

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    this.db.query(UPSERT_POINT_SQL).run(...pointParams(event))
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    if (events.length === 0) return

    this.db.transaction(() => {
      const upsert = this.db.query(UPSERT_POINT_SQL)
      for (const event of events) {
        upsert.run(...pointParams(event))
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
  source_event_id: string | null
}
