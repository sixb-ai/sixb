import type { StoredTelemetryAppendedEvent, TimeseriesPoint, TimeseriesStorage } from "@sixb/core"
import { type PgStoreClient, runPgTransaction } from "./transactions"

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

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    await this.upsertPoint(this.sql, event)
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    if (events.length === 0) return
    await runPgTransaction(this.sql, async (tx) => {
      for (const event of events) {
        await this.upsertPoint(tx, event)
      }
    })
  }

  // A telemetry point is uniquely identified by (series, at). Re-applying the
  // same instant is a last-write-wins upsert, so telemetry writes are idempotent
  // under replay without a separate dedup ledger.
  private async upsertPoint(
    sql: PgStoreClient,
    event: StoredTelemetryAppendedEvent
  ): Promise<void> {
    await sql`
      INSERT INTO timeseries (
        project_id, object_type_id, object_id, property_id,
        value, unit, at, source_event_id
      ) VALUES (
        ${event.projectId}, ${event.payload.objectTypeId}, ${event.payload.objectId},
        ${event.payload.propertyId},
        ${JSON.stringify(event.payload.value)}::text::jsonb,
        ${event.payload.unit ?? null}, ${event.payload.at}::timestamptz,
        ${event.id}
      )
      ON CONFLICT (project_id, object_type_id, object_id, property_id, at)
      DO UPDATE SET
        value = EXCLUDED.value,
        unit = EXCLUDED.unit,
        source_event_id = EXCLUDED.source_event_id
    `
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

  async getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null> {
    const [row] = await this.sql<TimeseriesDatabaseRow[]>`
      SELECT * FROM timeseries
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND object_id = ${params.objectId}
        AND property_id = ${params.propertyId}
      ORDER BY at DESC, source_event_id DESC
      LIMIT 1
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
    sourceEventId: row.source_event_id ?? undefined,
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
  source_event_id: string | null
}
