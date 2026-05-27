import type {
  LinkDirection,
  ObjectLinkRow,
  ObjectRow,
  ObjectStorage,
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "@pario/core"
import type { SQL } from "bun"

/**
 * Build a `SELECT ... JOIN (VALUES ...) AS t(...) ON ... WHERE ...` query
 * with positional parameters.  Bun SQL's tagged-template helpers don't
 * support VALUES inside SELECT/JOIN, so we construct the query string
 * manually while keeping all user data in the parameter array.
 */
function valuesJoin(
  sql: SQL,
  select: string,
  columns: string[],
  tuples: unknown[][],
  where: string,
  whereParams: unknown[]
) {
  const alias = "t"
  const colWidth = columns.length

  // $1 … $N are reserved for the WHERE params that come first.
  const base = whereParams.length
  const valuePlaceholders = tuples
    .map((_, i) => {
      const cols = columns.map((_, j) => `$${base + i * colWidth + j + 1}`)
      return `(${cols.join(",")})`
    })
    .join(",")

  const onClause = columns
    .map((c) => {
      // Infer the table alias from the SELECT clause (first word after SELECT ... FROM)
      const srcAlias = select.match(/FROM\s+\w+\s+(\w+)/i)?.[1] ?? select.split(" ").pop()
      return `${srcAlias}.${c} = ${alias}.${c}`
    })
    .join(" AND ")

  const query = `${select} JOIN (VALUES ${valuePlaceholders}) AS ${alias}(${columns.join(",")}) ON ${onClause} ${where}`
  const params = [...whereParams, ...tuples.flat()]

  return sql.unsafe(query, params)
}

/**
 * PostgreSQL-based ObjectStorage implementation.
 *
 * Stores object projections and links with full query support.
 * Uses JSONB for properties with GIN indexes for efficient `findFirst()` queries.
 *
 * Requires `search_path` to be set to the Pario schema on the connection.
 *
 * JSONB handling notes (Bun SQL specifics):
 * - Writes use `${JSON.stringify(v)}::text::jsonb`.  The `::text` forces the
 *   text wire type so that `::jsonb` parses the JSON text into a proper JSONB
 *   value (object, number, etc.) instead of a JSONB string literal.
 * - The `@>` containment operator receives a plain JS object which Bun SQL
 *   auto-serialises as JSONB.
 * - Reads return JSONB as native JS types (objects, numbers, booleans) when
 *   the data was stored correctly.
 */
export class PgObjectStorage implements ObjectStorage {
  constructor(private readonly sql: SQL) {}

  async applyObjectUpserted(event: StoredObjectUpsertedEvent): Promise<ObjectRow> {
    const occurredAt = new Date(event.occurredAt)

    const row = await this.sql.begin(async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `

      if (applied) {
        const [existing] = (await tx`
          SELECT * FROM objects
          WHERE project_id = ${event.projectId}
            AND object_type_id = ${event.payload.objectTypeId}
            AND primary_id = ${event.payload.primaryId}
        `) as ObjectDatabaseRow[]
        return existing ? rowToObject(existing) : null
      }

      const [existing] = (await tx`
        SELECT properties, created_at, version FROM objects
        WHERE project_id = ${event.projectId}
          AND object_type_id = ${event.payload.objectTypeId}
          AND primary_id = ${event.payload.primaryId}
      `) as { properties: Record<string, unknown>; created_at: Date; version: number }[]

      const existingProperties = existing ? existing.properties : {}
      const mergedProperties = { ...existingProperties, ...event.payload.properties }
      const createdAt = existing ? existing.created_at : occurredAt
      const version = (existing?.version ?? 0) + 1

      const [upserted] = (await tx`
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties, created_at, updated_at,
          version, source_event_id
        ) VALUES (
          ${event.projectId}, ${event.payload.objectTypeId}, ${event.payload.primaryId},
          ${JSON.stringify(mergedProperties)}::text::jsonb,
          ${createdAt}, ${occurredAt},
          ${version}, ${event.id}
        )
        ON CONFLICT (project_id, object_type_id, primary_id) DO UPDATE SET
          properties = objects.properties || ${JSON.stringify(event.payload.properties)}::text::jsonb,
          updated_at = EXCLUDED.updated_at,
          version = objects.version + 1,
          source_event_id = EXCLUDED.source_event_id
        RETURNING *
      `) as ObjectDatabaseRow[]

      await tx`
        INSERT INTO applied_events_objects (event_id)
        VALUES (${event.id})
        ON CONFLICT DO NOTHING
      `

      return rowToObject(upserted)
    })

    return row!
  }

  async applyObjectUpsertedBatch(
    events: readonly StoredObjectUpsertedEvent[]
  ): Promise<readonly ObjectRow[]> {
    if (events.length === 0) return []
    return this.sql.begin(async (tx) => {
      // 1. Bulk claim: single INSERT returns only the event_ids we now own.
      const claimedRows = await tx`
        INSERT INTO applied_events_objects
        ${this.sql(events.map((e) => ({ event_id: e.id })))}
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `
      const claimedSet = new Set(claimedRows.map((r: { event_id: string }) => r.event_id))

      // 2. Bulk lookup for already-applied events (need to return their current row).
      const alreadyApplied = events.filter((e) => !claimedSet.has(e.id))
      const results: ObjectRow[] = []

      if (alreadyApplied.length > 0) {
        const existingRows = (await valuesJoin(
          tx,
          "SELECT o.* FROM objects o",
          ["object_type_id", "primary_id"],
          alreadyApplied.map((e) => [e.payload.objectTypeId, e.payload.primaryId]),
          `WHERE o.project_id = $1`,
          [events[0].projectId]
        )) as ObjectDatabaseRow[]

        for (const row of existingRows) results.push(rowToObject(row))
      }

      // 3. Upsert claimed events. No pre-read needed — ON CONFLICT handles
      //    property merge, version increment, and created_at preservation.
      for (const event of events) {
        if (!claimedSet.has(event.id)) continue

        const occurredAt = new Date(event.occurredAt)

        const [upserted] = (await tx`
          INSERT INTO objects (
            project_id, object_type_id, primary_id, properties, created_at, updated_at,
            version, source_event_id
          ) VALUES (
            ${event.projectId}, ${event.payload.objectTypeId}, ${event.payload.primaryId},
            ${JSON.stringify(event.payload.properties)}::text::jsonb,
            ${occurredAt}, ${occurredAt},
            1, ${event.id}
          )
          ON CONFLICT (project_id, object_type_id, primary_id) DO UPDATE SET
            properties = objects.properties || EXCLUDED.properties,
            updated_at = EXCLUDED.updated_at,
            version = objects.version + 1,
            source_event_id = EXCLUDED.source_event_id
          RETURNING *
        `) as ObjectDatabaseRow[]

        results.push(rowToObject(upserted))
      }

      return results
    })
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `
      if (applied) return

      const [existing] = (await tx`
        SELECT properties FROM objects
        WHERE project_id = ${event.projectId}
          AND object_type_id = ${event.payload.objectTypeId}
          AND primary_id = ${event.payload.objectId}
      `) as { properties: Record<string, unknown> }[]

      if (!existing) return

      const properties = { ...existing.properties }
      properties[event.payload.propertyId] = event.payload.value

      await tx`
        UPDATE objects
        SET properties = ${JSON.stringify(properties)}::text::jsonb,
            updated_at = ${event.payload.at}::timestamptz,
            version = version + 1,
            source_event_id = ${event.id}
        WHERE project_id = ${event.projectId}
          AND object_type_id = ${event.payload.objectTypeId}
          AND primary_id = ${event.payload.objectId}
      `

      await tx`
        INSERT INTO applied_events_objects (event_id)
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
        SELECT event_id FROM applied_events_objects
        WHERE event_id IN ${this.sql(allEventIds)}
      `) as { event_id: string }[]
      const appliedSet = new Set(appliedRows.map((r) => r.event_id))

      // Group non-applied events by unique object to minimize reads/writes
      const objectGroups = new Map<
        string,
        {
          events: StoredTelemetryAppendedEvent[]
          projectId: string
          objectTypeId: string
          objectId: string
        }
      >()

      for (const event of events) {
        if (appliedSet.has(event.id)) continue

        const groupKey = `${event.projectId}:${event.payload.objectTypeId}:${event.payload.objectId}`
        let group = objectGroups.get(groupKey)
        if (!group) {
          group = {
            events: [],
            projectId: event.projectId,
            objectTypeId: event.payload.objectTypeId,
            objectId: event.payload.objectId,
          }
          objectGroups.set(groupKey, group)
        }
        group.events.push(event)
      }

      for (const group of objectGroups.values()) {
        const [existing] = (await tx`
          SELECT properties FROM objects
          WHERE project_id = ${group.projectId}
            AND object_type_id = ${group.objectTypeId}
            AND primary_id = ${group.objectId}
        `) as { properties: Record<string, unknown> }[]

        if (!existing) continue

        const properties = { ...existing.properties }
        let latestAt = ""
        let latestEventId = ""

        const newEventIds: string[] = []

        for (const event of group.events) {
          properties[event.payload.propertyId] = event.payload.value
          if (event.payload.at > latestAt) {
            latestAt = event.payload.at
            latestEventId = event.id
          }
          newEventIds.push(event.id)
        }

        // Batch insert applied events
        await tx`
          INSERT INTO applied_events_objects ${tx(newEventIds.map((id) => ({ event_id: id })))}
          ON CONFLICT DO NOTHING
        `

        await tx`
          UPDATE objects
          SET properties = ${JSON.stringify(properties)}::text::jsonb,
              updated_at = ${latestAt}::timestamptz,
              version = version + ${group.events.length},
              source_event_id = ${latestEventId}
          WHERE project_id = ${group.projectId}
            AND object_type_id = ${group.objectTypeId}
            AND primary_id = ${group.objectId}
        `
      }
    })
  }

  async applyLinkUpserted(event: StoredLinkUpsertedEvent): Promise<void> {
    const occurredAt = new Date(event.occurredAt)
    const linkProperties = event.payload.properties
      ? JSON.stringify(event.payload.properties)
      : null

    await this.sql.begin(async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `
      if (applied) return

      await tx`
        INSERT INTO links (
          project_id, source_type_id, source_id, link_id, target_type_id, target_id,
          properties, created_at, updated_at, source_event_id
        ) VALUES (
          ${event.projectId}, ${event.payload.sourceTypeId}, ${event.payload.sourceId},
          ${event.payload.linkId}, ${event.payload.targetTypeId}, ${event.payload.targetId},
          ${linkProperties}::text::jsonb, ${occurredAt}, ${occurredAt}, ${event.id}
        )
        ON CONFLICT (project_id, source_type_id, source_id, link_id, target_type_id, target_id)
        DO UPDATE SET
          properties = EXCLUDED.properties,
          updated_at = EXCLUDED.updated_at,
          source_event_id = EXCLUDED.source_event_id
      `

      await tx`
        INSERT INTO applied_events_objects (event_id)
        VALUES (${event.id})
        ON CONFLICT DO NOTHING
      `
    })
  }

  async applyLinkUpsertedBatch(events: readonly StoredLinkUpsertedEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.sql.begin(async (tx) => {
      // 1. Bulk claim: single INSERT returns only the event_ids we now own.
      const claimedRows = await tx`
        INSERT INTO applied_events_objects
        ${this.sql(events.map((e) => ({ event_id: e.id })))}
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `
      const claimedSet = new Set(claimedRows.map((r: { event_id: string }) => r.event_id))

      // 2. Upsert only claimed events
      for (const event of events) {
        if (!claimedSet.has(event.id)) continue

        const occurredAt = new Date(event.occurredAt)
        const linkProperties = event.payload.properties
          ? JSON.stringify(event.payload.properties)
          : null

        await tx`
          INSERT INTO links (
            project_id, source_type_id, source_id, link_id, target_type_id, target_id,
            properties, created_at, updated_at, source_event_id
          ) VALUES (
            ${event.projectId}, ${event.payload.sourceTypeId}, ${event.payload.sourceId},
            ${event.payload.linkId}, ${event.payload.targetTypeId}, ${event.payload.targetId},
            ${linkProperties}::text::jsonb, ${occurredAt}, ${occurredAt}, ${event.id}
          )
          ON CONFLICT (project_id, source_type_id, source_id, link_id, target_type_id, target_id)
          DO UPDATE SET
            properties = EXCLUDED.properties,
            updated_at = EXCLUDED.updated_at,
            source_event_id = EXCLUDED.source_event_id
        `
      }
    })
  }

  async applyLinkRemoved(event: StoredLinkRemovedEvent): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `
      if (applied) return

      await tx`
        DELETE FROM links
        WHERE project_id = ${event.projectId}
          AND source_type_id = ${event.payload.sourceTypeId}
          AND source_id = ${event.payload.sourceId}
          AND link_id = ${event.payload.linkId}
          AND target_type_id = ${event.payload.targetTypeId}
          AND target_id = ${event.payload.targetId}
      `

      await tx`
        INSERT INTO applied_events_objects (event_id)
        VALUES (${event.id})
        ON CONFLICT DO NOTHING
      `
    })
  }

  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    const [row] = (await this.sql`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND primary_id = ${params.primaryId}
    `) as ObjectDatabaseRow[]

    return row ? rowToObject(row) : null
  }

  async findFirst(params: {
    projectId: string
    objectTypeId: string
    where?: readonly { propertyId: string; op: "eq"; value: unknown }[]
  }): Promise<ObjectRow | null> {
    if (params.where && params.where.length > 0) {
      // Build a JSONB containment check using @>
      const conditions: Record<string, unknown> = {}
      for (const clause of params.where) {
        if (clause.op === "eq") {
          conditions[clause.propertyId] = clause.value
        }
      }

      // Pass the JS object directly — Bun SQL auto-serialises it as JSONB
      const [row] = (await this.sql`
        SELECT * FROM objects
        WHERE project_id = ${params.projectId}
          AND object_type_id = ${params.objectTypeId}
          AND properties @> ${conditions}
        LIMIT 1
      `) as ObjectDatabaseRow[]

      return row ? rowToObject(row) : null
    }

    const [row] = (await this.sql`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
      LIMIT 1
    `) as ObjectDatabaseRow[]

    return row ? rowToObject(row) : null
  }

  async listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]> {
    const direction = params.direction ?? "outgoing"
    const directionWhere =
      direction === "incoming"
        ? "target_type_id = $2 AND target_id = $3"
        : direction === "both"
          ? "((source_type_id = $2 AND source_id = $3) OR (target_type_id = $2 AND target_id = $3))"
          : "source_type_id = $2 AND source_id = $3"
    const query = `SELECT * FROM links WHERE project_id = $1 AND ${directionWhere}${
      params.linkId ? " AND link_id = $4" : ""
    }`
    const args = params.linkId
      ? [params.projectId, params.objectTypeId, params.objectId, params.linkId]
      : [params.projectId, params.objectTypeId, params.objectId]
    const rows = (await this.sql.unsafe(query, args)) as LinkDatabaseRow[]

    return rows.map((row) => rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>> {
    const result = new Map<string, ObjectRow>()
    if (params.items.length === 0) return result
    const rows = (await valuesJoin(
      this.sql,
      "SELECT o.* FROM objects o",
      ["object_type_id", "primary_id"],
      params.items.map((i) => [i.objectTypeId, i.primaryId]),
      `WHERE o.project_id = $1`,
      [params.projectId]
    )) as ObjectDatabaseRow[]

    for (const row of rows) {
      result.set(`${row.object_type_id}:${row.primary_id}`, rowToObject(row))
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>> {
    const result = new Map<string, ObjectLinkRow[]>()
    if (params.items.length === 0) return result
    const rows = (await valuesJoin(
      this.sql,
      "SELECT l.* FROM links l",
      ["source_type_id", "source_id", "link_id"],
      params.items.map((i) => [i.objectTypeId, i.objectId, i.linkId]),
      `WHERE l.project_id = $1`,
      [params.projectId]
    )) as LinkDatabaseRow[]

    for (const row of rows) {
      const key = `${row.source_type_id}:${row.source_id}:${row.link_id}`
      const existing = result.get(key) ?? []
      existing.push(rowToLink(row))
      result.set(key, existing)
    }
    return result
  }

  async list(params: {
    projectId: string
    objectTypeId?: string | readonly string[]
    primaryIdPrefix?: string
    primaryIdSuffix?: string
    updatedAfter?: Date
    updatedBefore?: Date
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
    offset?: number
    orderBy?: "createdAt" | "updatedAt" | "primaryId"
    order?: "asc" | "desc"
  }): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    const queryOffset = params.offset ?? 0
    const limit = params.limit ?? 50
    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"
    const orderColumn =
      orderBy === "primaryId" ? "primary_id" : orderBy === "createdAt" ? "created_at" : "updated_at"

    // Build WHERE conditions using conditional fragments
    const typeFilter =
      params.objectTypeId === undefined
        ? this.sql``
        : typeof params.objectTypeId === "string"
          ? this.sql`AND object_type_id = ${params.objectTypeId}`
          : this.sql`AND object_type_id IN ${this.sql(params.objectTypeId as string[])}`

    const primaryIdPrefixFilter = params.primaryIdPrefix
      ? this.sql`AND primary_id LIKE ${`${params.primaryIdPrefix}%`}`
      : this.sql``

    const primaryIdSuffixFilter = params.primaryIdSuffix
      ? this.sql`AND primary_id LIKE ${`%${params.primaryIdSuffix}`}`
      : this.sql``

    const updatedAfterFilter = params.updatedAfter
      ? this.sql`AND updated_at >= ${params.updatedAfter}`
      : this.sql``

    const updatedBeforeFilter = params.updatedBefore
      ? this.sql`AND updated_at <= ${params.updatedBefore}`
      : this.sql``

    const createdAfterFilter = params.createdAfter
      ? this.sql`AND created_at >= ${params.createdAfter}`
      : this.sql``

    const createdBeforeFilter = params.createdBefore
      ? this.sql`AND created_at <= ${params.createdBefore}`
      : this.sql``

    const filters = this.sql`
      ${typeFilter}
      ${primaryIdPrefixFilter}
      ${primaryIdSuffixFilter}
      ${updatedAfterFilter}
      ${updatedBeforeFilter}
      ${createdAfterFilter}
      ${createdBeforeFilter}
    `

    // Get total count
    const [countResult] = (await this.sql`
      SELECT COUNT(*)::int AS total FROM objects
      WHERE project_id = ${params.projectId}
      ${filters}
    `) as { total: number }[]
    const total = countResult.total

    if (limit === 0) return { objects: [], hasMore: queryOffset < total, total }

    // Get paginated results (+1 for hasMore check)
    // Column and direction derived from a fixed mapping — safe to use as identifiers
    const fetchLimit = limit + 1
    const rows = (await this.sql`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
      ${filters}
      ORDER BY ${this.sql(orderColumn)} ${order === "asc" ? this.sql`ASC` : this.sql`DESC`}
      LIMIT ${fetchLimit}
      OFFSET ${queryOffset}
    `) as ObjectDatabaseRow[]

    const hasMore = rows.length > limit
    const objects = rows.slice(0, limit).map((row) => rowToObject(row))

    return { objects, hasMore, total }
  }
}

function rowToObject(row: ObjectDatabaseRow): ObjectRow {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    properties: row.properties as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    sourceEventId: row.source_event_id ?? undefined,
  }
}

function rowToLink(row: LinkDatabaseRow): ObjectLinkRow {
  return {
    projectId: row.project_id,
    sourceTypeId: row.source_type_id,
    sourceId: row.source_id,
    linkId: row.link_id,
    targetTypeId: row.target_type_id,
    targetId: row.target_id,
    properties: row.properties ? (row.properties as Record<string, unknown>) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    sourceEventId: row.source_event_id ?? undefined,
  }
}

interface ObjectDatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: unknown
  created_at: Date | string
  updated_at: Date | string
  version: number
  source_event_id: string | null
}

interface LinkDatabaseRow {
  project_id: string
  source_type_id: string
  source_id: string
  link_id: string
  target_type_id: string
  target_id: string
  properties: unknown | null
  created_at: Date | string
  updated_at: Date | string
  source_event_id: string | null
}
