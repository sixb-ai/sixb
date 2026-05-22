import type { StoredTelemetryAppendedEvent, TimeseriesPoint, TimeseriesStorage } from "@pario/core"
import type { SQL } from "bun"

/**
 * PostgreSQL-based TimeseriesStorage implementation.
 *
 * Stores time-series data with JSONB values and TIMESTAMPTZ timestamps
 * for efficient querying of history and latest values.
 *
 * Requires `search_path` to be set to the Pario schema on the connection.
 */
export class PgTimeseriesStorage implements TimeseriesStorage {
  constructor(private readonly sql: SQL) {}

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_timeseries WHERE event_id = ${event.id}
      `
      if (applied) return

      await tx`
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
        ON CONFLICT (project_id, object_type_id, object_id, property_id, at, source_event_id)
        DO NOTHING
      `

      await tx`
        INSERT INTO applied_events_timeseries (event_id)
        VALUES (${event.id})
        ON CONFLICT DO NOTHING
      `
    })
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    if (events.length === 0) return
    await this.sql.begin(async (tx) => {
      // Batch idempotence check: single query instead of N individual SELECTs
      const allEventIds = events.map((e) => e.id)
      const appliedRows = (await tx`
        SELECT event_id FROM applied_events_timeseries
        WHERE event_id IN ${this.sql(allEventIds)}
      `) as { event_id: string }[]
      const appliedSet = new Set(appliedRows.map((r) => r.event_id))

      for (const event of events) {
        if (appliedSet.has(event.id)) continue

        await tx`
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
          ON CONFLICT (project_id, object_type_id, object_id, property_id, at, source_event_id)
          DO NOTHING
        `

        await tx`
          INSERT INTO applied_events_timeseries (event_id)
          VALUES (${event.id})
          ON CONFLICT DO NOTHING
        `
      }
    })
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

    const rows = (await this.sql`
      SELECT * FROM timeseries
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND object_id = ${params.objectId}
        AND property_id = ${params.propertyId}
        ${fromFilter}
        ${toFilter}
      ORDER BY at ${order === "asc" ? this.sql`ASC` : this.sql`DESC`}
      ${limitFilter}
    `) as TimeseriesDatabaseRow[]

    return rows.map((row) => rowToPoint(row))
  }

  async getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null> {
    const [row] = (await this.sql`
      SELECT * FROM timeseries
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND object_id = ${params.objectId}
        AND property_id = ${params.propertyId}
      ORDER BY at DESC, source_event_id DESC
      LIMIT 1
    `) as TimeseriesDatabaseRow[]

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
