import type { ObjectQuery } from "@sixb/core"
import type { EditCommitPlan } from "@sixb/core/internal/edits"
import type {
  StoredLinkDeletedEvent,
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredTelemetryAppendedEvent,
} from "@sixb/core/internal/events"
import type {
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  ExpandedLinkValue,
  ExpandedObjectRow,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkDirection,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectRow,
  ObjectRowLinks,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import {
  editCommitLinkCreateConflict,
  editCommitLinkUpdateMissing,
  editCommitObjectCreateConflict,
  editCommitObjectUpdateMissing,
  ObjectStorageError,
} from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "./pg-client"
import {
  type CompiledPgObjectQuery,
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
} from "./pg-object-query-compiler"
import { type PgStoreClient, runPgTransaction } from "./transactions"

const PG_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
  queryObjects: true,
  countObjects: true,
  existsObjects: true,
  facetObjects: true,
  nodes: {
    start: true,
    filter: true,
    text: true,
    sort: true,
    limit: true,
    page: true,
    traverse: true,
    set: true,
    project: true,
    expand: true,
  },
  predicateOps: {
    and: true,
    or: true,
    not: true,
    eq: true,
    neq: true,
    lt: true,
    lte: true,
    gt: true,
    gte: true,
    in: true,
    exists: true,
    contains: true,
  },
  sortKinds: {
    property: true,
  },
  traversalDirections: {
    outgoing: true,
    incoming: true,
  },
  setOps: {
    union: true,
    intersect: true,
    subtract: true,
  },
  limits: {
    totalCount: true,
    stablePageTokens: true,
  },
  notes: [
    "PostgreSQL object query pushdown supports start/filter/text/sort/limit/page/traverse/set/project/expand over JSONB properties and object links.",
    "expand hydrates linked objects in-database (top-N per parent via LATERAL + jsonb_agg); core resolves each expansion's cardinality before pushdown, and a mixed/unresolved one stays on the fallback.",
    "Relevance sorting, vector search, and unresolved start.includeSubtypes remain planner fallback or rejection cases.",
  ],
}

/**
 * Build a `SELECT ... JOIN (VALUES ...) AS t(...) ON ... WHERE ...` query
 * with positional parameters.  Bun SQL's tagged-template helpers don't
 * support VALUES inside SELECT/JOIN, so we construct the query string
 * manually while keeping all user data in the parameter array.
 */
function valuesJoin<Row = unknown>(
  sql: SQLClient,
  select: string,
  columns: string[],
  tuples: unknown[][],
  where: string,
  whereParams: unknown[]
): Promise<Row[]> {
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

  return sql.unsafe(query, params as SqlParameter[]) as unknown as Promise<Row[]>
}

/**
 * PostgreSQL-based ObjectStorage implementation.
 *
 * Stores object projections and links. V1 object-query IR pushdown covers the
 * scalar JSONB-property and link-traversal subset declared by queryCapabilities().
 *
 * Requires `search_path` to be set to the Sixb schema on the connection.
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
  constructor(private readonly sql: PgStoreClient) {}

  queryCapabilities(): ObjectQueryCapabilities {
    return PG_OBJECT_QUERY_CAPABILITIES
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    const compiled = compilePgObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
    })
    const total = params.includeTotal === false ? undefined : await readTotal(this.sql, compiled)
    const rawRows = await this.sql.unsafe<ObjectQueryDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    const rows = compiled.trimRows(rawRows) as readonly ObjectQueryDatabaseRow[]
    const hasMore =
      total === undefined && compiled.hasMoreProbe
        ? compiled.hasMoreProbe.hasMore(
            (
              await this.sql.unsafe(
                compiled.hasMoreProbe.sql,
                compiled.hasMoreProbe.args as SqlParameter[]
              )
            ).length
          )
        : compiled.hasMore(rawRows.length, total)

    return {
      objects: rows.map((row) => queryRowToObject(row)),
      hasMore,
      nextPageToken: compiled.nextPageToken(rows, rawRows.length),
      ...(total === undefined ? {} : { total }),
    }
  }

  async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    const compiled = compilePgObjectCountQuery(params.projectId, stripOuterRowShape(params.query))
    const [row] = await this.sql.unsafe<{ count: string | number | bigint }[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    return { count: Number(row?.count ?? 0) }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    const compiled = compilePgObjectExistsQuery(params.projectId, stripOuterRowShape(params.query))
    const [row] = await this.sql.unsafe<unknown[]>(compiled.sql, compiled.args as SqlParameter[])
    return { exists: row !== undefined }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return {
      facets: await Promise.all(
        params.facets.map(async (facet) => ({
          propertyId: facet.propertyId,
          buckets: await readFacetBuckets(
            this.sql,
            compilePgObjectFacetQuery(
              params.projectId,
              stripOuterRowShape(params.query),
              facet.propertyId,
              facet.limit
            )
          ),
        }))
      ),
    }
  }

  async applyObjectUpsert(event: StoredObjectMutationEvent): Promise<ObjectRow> {
    const occurredAt = new Date(event.occurredAt)

    const row = await runPgTransaction(this.sql, async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `

      if (applied) {
        const [existing] = await tx<ObjectDatabaseRow[]>`
          SELECT * FROM objects
          WHERE project_id = ${event.projectId}
            AND object_type_id = ${event.payload.objectTypeId}
            AND primary_id = ${event.payload.primaryId}
        `
        return existing ? rowToObject(existing) : null
      }

      const [existing] = await tx<
        { properties: Record<string, unknown>; created_at: Date; version: number }[]
      >`
        SELECT properties, created_at, version FROM objects
        WHERE project_id = ${event.projectId}
          AND object_type_id = ${event.payload.objectTypeId}
          AND primary_id = ${event.payload.primaryId}
      `

      const existingProperties = existing ? existing.properties : {}
      const mergedProperties = { ...existingProperties, ...event.payload.properties }
      const createdAt = existing ? existing.created_at : occurredAt
      const version = (existing?.version ?? 0) + 1

      const [upserted] = await tx<ObjectDatabaseRow[]>`
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
      `

      await tx`
        INSERT INTO applied_events_objects (event_id)
        VALUES (${event.id})
        ON CONFLICT DO NOTHING
      `

      return rowToObject(upserted)
    })

    return row!
  }

  async applyObjectUpsertBatch(
    events: readonly StoredObjectMutationEvent[]
  ): Promise<readonly ObjectRow[]> {
    if (events.length === 0) return []
    return runPgTransaction(this.sql, async (tx) => {
      // 1. Bulk claim: single INSERT returns only the event_ids we now own.
      const claimedRows = await tx<{ event_id: string }[]>`
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
        const existingRows = await valuesJoin<ObjectDatabaseRow>(
          tx,
          "SELECT o.* FROM objects o",
          ["object_type_id", "primary_id"],
          alreadyApplied.map((e) => [e.payload.objectTypeId, e.payload.primaryId]),
          `WHERE o.project_id = $1`,
          [events[0].projectId]
        )

        for (const row of existingRows) results.push(rowToObject(row))
      }

      // 3. Upsert claimed events. No pre-read needed — ON CONFLICT handles
      //    property merge, version increment, and created_at preservation.
      for (const event of events) {
        if (!claimedSet.has(event.id)) continue

        const occurredAt = new Date(event.occurredAt)

        const [upserted] = await tx<ObjectDatabaseRow[]>`
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
        `

        results.push(rowToObject(upserted))
      }

      return results
    })
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    await runPgTransaction(this.sql, async (tx) => {
      // Idempotence check inside transaction to prevent race conditions
      const [applied] = await tx`
        SELECT 1 FROM applied_events_objects WHERE event_id = ${event.id}
      `
      if (applied) return

      const [existing] = await tx<{ properties: Record<string, unknown> }[]>`
        SELECT properties FROM objects
        WHERE project_id = ${event.projectId}
          AND object_type_id = ${event.payload.objectTypeId}
          AND primary_id = ${event.payload.objectId}
      `

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
    await runPgTransaction(this.sql, async (tx) => {
      // Batch idempotence check: single query instead of N individual SELECTs
      const allEventIds = events.map((e) => e.id)
      const appliedRows = await tx<{ event_id: string }[]>`
        SELECT event_id FROM applied_events_objects
        WHERE event_id IN ${this.sql(allEventIds)}
      `
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
        const [existing] = await tx<{ properties: Record<string, unknown> }[]>`
          SELECT properties FROM objects
          WHERE project_id = ${group.projectId}
            AND object_type_id = ${group.objectTypeId}
            AND primary_id = ${group.objectId}
        `

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

  async applyLinkUpsert(event: StoredLinkMutationEvent): Promise<void> {
    const occurredAt = new Date(event.occurredAt)
    const linkProperties = event.payload.properties
      ? JSON.stringify(event.payload.properties)
      : null

    await runPgTransaction(this.sql, async (tx) => {
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

  async applyLinkUpsertBatch(events: readonly StoredLinkMutationEvent[]): Promise<void> {
    if (events.length === 0) return
    await runPgTransaction(this.sql, async (tx) => {
      // 1. Bulk claim: single INSERT returns only the event_ids we now own.
      const claimedRows = await tx<{ event_id: string }[]>`
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

  async applyLinkDelete(event: StoredLinkDeletedEvent): Promise<void> {
    await runPgTransaction(this.sql, async (tx) => {
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
    const [row] = await this.sql<ObjectDatabaseRow[]>`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        AND primary_id = ${params.primaryId}
    `

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
    const rows = await this.sql.unsafe<LinkDatabaseRow[]>(query, args)

    return rows.map((row) => rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>> {
    const result = new Map<string, ObjectRow>()
    if (params.items.length === 0) return result
    const rows = await valuesJoin<ObjectDatabaseRow>(
      this.sql,
      "SELECT o.* FROM objects o",
      ["object_type_id", "primary_id"],
      params.items.map((i) => [i.objectTypeId, i.primaryId]),
      `WHERE o.project_id = $1`,
      [params.projectId]
    )

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
    const rows = await valuesJoin<LinkDatabaseRow>(
      this.sql,
      "SELECT l.* FROM links l",
      ["source_type_id", "source_id", "link_id"],
      params.items.map((i) => [i.objectTypeId, i.objectId, i.linkId]),
      `WHERE l.project_id = $1`,
      [params.projectId]
    )

    for (const row of rows) {
      const key = `${row.source_type_id}:${row.source_id}:${row.link_id}`
      const existing = result.get(key) ?? []
      existing.push(rowToLink(row))
      result.set(key, existing)
    }
    return result
  }

  async listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]> {
    if (params.items.length === 0) return []
    const tuples = params.items.map((item) => [item.objectTypeId, item.objectId])

    // Cover both link directions with two index-friendly equality joins (source-side, then
    // target-side) rather than a single OR-join, which would defeat index usage. This is a constant
    // number of round trips regardless of how many objects are deleted — issued sequentially because
    // these reads run on the serializable commit transaction's single connection. A link incident to
    // two listed objects matches both halves and is de-duplicated below.
    const sourceRows = await valuesJoin<LinkDatabaseRow>(
      this.sql,
      "SELECT l.* FROM links l",
      ["source_type_id", "source_id"],
      tuples,
      "WHERE l.project_id = $1",
      [params.projectId]
    )
    const targetRows = await valuesJoin<LinkDatabaseRow>(
      this.sql,
      "SELECT l.* FROM links l",
      ["target_type_id", "target_id"],
      tuples,
      "WHERE l.project_id = $1",
      [params.projectId]
    )

    const deduped = new Map<string, ObjectLinkRow>()
    for (const row of [...sourceRows, ...targetRows]) {
      const link = rowToLink(row)
      deduped.set(
        `${link.sourceTypeId}:${link.sourceId}:${link.linkId}:${link.targetTypeId}:${link.targetId}`,
        link
      )
    }
    return [...deduped.values()]
  }

  async applyEditCommitPlan(input: {
    projectId: string
    plan: EditCommitPlan
    committedAt: Date
  }): Promise<void> {
    // Ordering contract shared with the in-memory and SQLite providers: link deletes, then object
    // deletes, then object upserts, then link upserts, so cascades and re-links resolve correctly.
    // Within objects (and within links) Postgres applies all creates as one set-based statement and
    // all updates as another, instead of walking the plan in order like the other providers. That
    // regrouping is safe because the net-diff planner emits at most one operation per key, so a
    // create and an update never touch the same row — there is no create-vs-update order to preserve.
    await deleteLinks(this.sql, input.projectId, input.plan.links.deletes)
    await deleteObjects(this.sql, input.projectId, input.plan.objects.deletes)
    await createObjects(this.sql, input.projectId, input.plan.objects.upserts, input.committedAt)
    await updateObjects(this.sql, input.projectId, input.plan.objects.upserts, input.committedAt)
    await createLinks(this.sql, input.projectId, input.plan.links.upserts, input.committedAt)
    await updateLinks(this.sql, input.projectId, input.plan.links.upserts, input.committedAt)
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
    const [countResult] = await this.sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM objects
      WHERE project_id = ${params.projectId}
      ${filters}
    `
    const total = countResult.total

    if (limit === 0) return { objects: [], hasMore: queryOffset < total, total }

    // Get paginated results (+1 for hasMore check)
    // Column and direction derived from a fixed mapping — safe to use as identifiers
    const fetchLimit = limit + 1
    const rows = await this.sql<ObjectDatabaseRow[]>`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
      ${filters}
      ORDER BY ${this.sql(orderColumn)} ${order === "asc" ? this.sql`ASC` : this.sql`DESC`}
      LIMIT ${fetchLimit}
      OFFSET ${queryOffset}
    `

    const hasMore = rows.length > limit
    const objects = rows.slice(0, limit).map((row) => rowToObject(row))

    return { objects, hasMore, total }
  }
}

async function readTotal(sql: SQLClient, compiled: CompiledPgObjectQuery): Promise<number> {
  const [row] = await sql.unsafe<
    {
      total: string | number | bigint
    }[]
  >(compiled.totalSql, compiled.totalArgs as SqlParameter[])
  return Number(row?.total ?? 0)
}

async function deleteLinks(
  sql: SQLClient,
  projectId: string,
  deletes: EditCommitPlan["links"]["deletes"]
): Promise<void> {
  if (deletes.length === 0) return

  await sql`
    WITH requested AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        deletes.map((linkDelete) => ({
          source_object_type_id: linkDelete.source.objectTypeId,
          source_primary_id: linkDelete.source.primaryId,
          link_id: linkDelete.linkId,
          target_object_type_id: linkDelete.target.objectTypeId,
          target_primary_id: linkDelete.target.primaryId,
        }))
      )}::text::jsonb) AS requested(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text
      )
    )
    DELETE FROM links l
    USING requested r
    WHERE l.project_id = ${projectId}
      AND l.source_type_id = r.source_object_type_id
      AND l.source_id = r.source_primary_id
      AND l.link_id = r.link_id
      AND l.target_type_id = r.target_object_type_id
      AND l.target_id = r.target_primary_id
  `
}

async function deleteObjects(
  sql: SQLClient,
  projectId: string,
  deletes: EditCommitPlan["objects"]["deletes"]
): Promise<void> {
  if (deletes.length === 0) return

  await sql`
    WITH requested AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        deletes.map((objectDelete) => ({
          object_type_id: objectDelete.objectTypeId,
          primary_id: objectDelete.primaryId,
        }))
      )}::text::jsonb) AS requested(object_type_id text, primary_id text)
    )
    DELETE FROM objects o
    USING requested r
    WHERE o.project_id = ${projectId}
      AND o.object_type_id = r.object_type_id
      AND o.primary_id = r.primary_id
  `
}

// Postgres applies each kind of upsert as a single set-based statement, so the offending row is not
// known up front. Both `INSERT … ON CONFLICT DO NOTHING` and `UPDATE … FROM` use `RETURNING`, so a
// count mismatch is reconciled by diffing the affected rows against the requested ones, recovering
// the same per-entity identity the in-memory and SQLite providers report. Identity columns are
// keyed via JSON so no in-band delimiter can collide with a type or primary id.
function editEntityKey(parts: readonly string[]): string {
  return JSON.stringify(parts)
}

async function createObjects(
  sql: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["objects"]["upserts"],
  committedAt: Date
): Promise<void> {
  const creates = upserts.filter((upsert) => upsert.operation === "create")
  if (creates.length === 0) return

  const inserted = await sql<{ object_type_id: string; primary_id: string }[]>`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        creates.map((objectCreate) => ({
          object_type_id: objectCreate.objectTypeId,
          primary_id: objectCreate.primaryId,
          properties: objectCreate.properties,
        }))
      )}::text::jsonb) AS input(object_type_id text, primary_id text, properties jsonb)
    )
    INSERT INTO objects (
      project_id, object_type_id, primary_id, properties, created_at, updated_at, version,
      source_event_id
    )
    SELECT
      ${projectId},
      input.object_type_id,
      input.primary_id,
      input.properties,
      ${committedAt},
      ${committedAt},
      1,
      NULL
    FROM input
    ON CONFLICT (project_id, object_type_id, primary_id) DO NOTHING
    RETURNING object_type_id, primary_id
  `

  if (inserted.length !== creates.length) {
    const insertedKeys = new Set(
      inserted.map((row) => editEntityKey([row.object_type_id, row.primary_id]))
    )
    const conflict = creates.find(
      (create) => !insertedKeys.has(editEntityKey([create.objectTypeId, create.primaryId]))
    )
    if (conflict) {
      throw editCommitObjectCreateConflict(conflict)
    }
    // Unreachable: ON CONFLICT DO NOTHING only ever inserts fewer rows, so a count mismatch always
    // leaves at least one requested create unaccounted for above.
    throw new ObjectStorageError(`[SixbPg] Edit commit cannot create one or more existing objects.`)
  }
}

async function updateObjects(
  sql: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["objects"]["upserts"],
  committedAt: Date
): Promise<void> {
  const updates = upserts.filter((upsert) => upsert.operation === "update")
  if (updates.length === 0) return

  const updated = await sql<{ object_type_id: string; primary_id: string }[]>`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        updates.map((objectUpdate) => ({
          object_type_id: objectUpdate.objectTypeId,
          primary_id: objectUpdate.primaryId,
          properties: objectUpdate.properties,
        }))
      )}::text::jsonb) AS input(object_type_id text, primary_id text, properties jsonb)
    )
    UPDATE objects o
    SET properties = input.properties,
        updated_at = ${committedAt},
        version = o.version + 1,
        source_event_id = NULL
    FROM input
    WHERE o.project_id = ${projectId}
      AND o.object_type_id = input.object_type_id
      AND o.primary_id = input.primary_id
    RETURNING o.object_type_id, o.primary_id
  `

  if (updated.length !== updates.length) {
    const updatedKeys = new Set(
      updated.map((row) => editEntityKey([row.object_type_id, row.primary_id]))
    )
    const missing = updates.find(
      (update) => !updatedKeys.has(editEntityKey([update.objectTypeId, update.primaryId]))
    )
    if (missing) {
      throw editCommitObjectUpdateMissing(missing)
    }
    // Unreachable: the join only updates matching rows, so a count mismatch always leaves at least
    // one requested update unaccounted for above.
    throw new ObjectStorageError(`[SixbPg] Edit commit cannot update one or more missing objects.`)
  }
}

async function createLinks(
  sql: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["links"]["upserts"],
  committedAt: Date
): Promise<void> {
  const creates = upserts.filter((upsert) => upsert.operation === "create")
  if (creates.length === 0) return

  const inserted = await sql<
    {
      source_type_id: string
      source_id: string
      link_id: string
      target_type_id: string
      target_id: string
    }[]
  >`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        creates.map((linkCreate) => ({
          source_object_type_id: linkCreate.source.objectTypeId,
          source_primary_id: linkCreate.source.primaryId,
          link_id: linkCreate.linkId,
          target_object_type_id: linkCreate.target.objectTypeId,
          target_primary_id: linkCreate.target.primaryId,
          properties: linkCreate.properties ?? null,
        }))
      )}::text::jsonb) AS input(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text,
        properties jsonb
      )
    )
    INSERT INTO links (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties,
      created_at, updated_at, source_event_id
    )
    SELECT
      ${projectId},
      input.source_object_type_id,
      input.source_primary_id,
      input.link_id,
      input.target_object_type_id,
      input.target_primary_id,
      input.properties,
      ${committedAt},
      ${committedAt},
      NULL
    FROM input
    ON CONFLICT (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id
    ) DO NOTHING
    RETURNING source_type_id, source_id, link_id, target_type_id, target_id
  `

  if (inserted.length !== creates.length) {
    const insertedKeys = new Set(
      inserted.map((row) =>
        editEntityKey([
          row.source_type_id,
          row.source_id,
          row.link_id,
          row.target_type_id,
          row.target_id,
        ])
      )
    )
    const conflict = creates.find(
      (create) =>
        !insertedKeys.has(
          editEntityKey([
            create.source.objectTypeId,
            create.source.primaryId,
            create.linkId,
            create.target.objectTypeId,
            create.target.primaryId,
          ])
        )
    )
    if (conflict) {
      throw editCommitLinkCreateConflict(conflict)
    }
    // Unreachable: ON CONFLICT DO NOTHING only ever inserts fewer rows, so a count mismatch always
    // leaves at least one requested create unaccounted for above.
    throw new ObjectStorageError(`[SixbPg] Edit commit cannot create one or more existing links.`)
  }
}

async function updateLinks(
  sql: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["links"]["upserts"],
  committedAt: Date
): Promise<void> {
  const updates = upserts.filter((upsert) => upsert.operation === "update")
  if (updates.length === 0) return

  const updated = await sql<
    {
      source_type_id: string
      source_id: string
      link_id: string
      target_type_id: string
      target_id: string
    }[]
  >`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        updates.map((linkUpdate) => ({
          source_object_type_id: linkUpdate.source.objectTypeId,
          source_primary_id: linkUpdate.source.primaryId,
          link_id: linkUpdate.linkId,
          target_object_type_id: linkUpdate.target.objectTypeId,
          target_primary_id: linkUpdate.target.primaryId,
          properties: linkUpdate.properties ?? null,
        }))
      )}::text::jsonb) AS input(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text,
        properties jsonb
      )
    )
    UPDATE links l
    SET properties = input.properties,
        updated_at = ${committedAt},
        source_event_id = NULL
    FROM input
    WHERE l.project_id = ${projectId}
      AND l.source_type_id = input.source_object_type_id
      AND l.source_id = input.source_primary_id
      AND l.link_id = input.link_id
      AND l.target_type_id = input.target_object_type_id
      AND l.target_id = input.target_primary_id
    RETURNING l.source_type_id, l.source_id, l.link_id, l.target_type_id, l.target_id
  `

  if (updated.length !== updates.length) {
    const updatedKeys = new Set(
      updated.map((row) =>
        editEntityKey([
          row.source_type_id,
          row.source_id,
          row.link_id,
          row.target_type_id,
          row.target_id,
        ])
      )
    )
    const missing = updates.find(
      (update) =>
        !updatedKeys.has(
          editEntityKey([
            update.source.objectTypeId,
            update.source.primaryId,
            update.linkId,
            update.target.objectTypeId,
            update.target.primaryId,
          ])
        )
    )
    if (missing) {
      throw editCommitLinkUpdateMissing(missing)
    }
    // Unreachable: the join only updates matching rows, so a count mismatch always leaves at least
    // one requested update unaccounted for above.
    throw new ObjectStorageError(`[SixbPg] Edit commit cannot update one or more missing links.`)
  }
}

async function readFacetBuckets(
  sql: SQLClient,
  compiled: { sql: string; args: readonly unknown[] }
): Promise<{ value: unknown; count: number }[]> {
  const rows = await sql.unsafe<FacetDatabaseRow[]>(compiled.sql, [
    ...compiled.args,
  ] as SqlParameter[])

  return rows.map((row) => ({
    value: pgFacetValue(row.value_type, row.value_text),
    count: Number(row.count),
  }))
}

function pgFacetValue(valueType: string | null, valueText: string | null): unknown {
  switch (valueType) {
    case "string":
      return valueText ?? ""
    case "number":
      return valueText === null ? null : Number(valueText)
    case "boolean":
      return valueText === "true"
    case "null":
      return null
    case "array":
    case "object":
      return valueText === null ? null : JSON.parse(valueText)
    default:
      return valueText
  }
}

function stripOuterRowShape(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "limit":
    case "page":
    case "project":
    case "sort":
      return stripOuterRowShape(query.input)
    default:
      return query
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
    lastCommitId: row.last_commit_id ?? undefined,
  }
}

// Map a query row, attaching `links` when an `expand` pushdown produced them. The
// base columns map as usual; `_expand` (a `jsonb_build_object`) is revived into
// the runtime link shape the core executor's fallback also produces.
function queryRowToObject(row: ObjectQueryDatabaseRow): ObjectRow {
  const base = rowToObject(row)
  const links = reviveExpandedLinks(row._expand)
  return links ? { ...base, links } : base
}

function reviveExpandedLinks(value: unknown): ObjectRowLinks | undefined {
  if (!isPlainRecord(value)) return undefined
  const links: ObjectRowLinks = {}
  for (const [linkId, raw] of Object.entries(value)) {
    links[linkId] = reviveExpandedLinkValue(raw)
  }
  return links
}

// A "one" expansion arrives as a single object or null; a "many" expansion as an
// array (already ordered and trimmed in the database).
function reviveExpandedLinkValue(value: unknown): ExpandedLinkValue {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(reviveExpandedRow)
  return reviveExpandedRow(value)
}

// Revive one hydrated neighbour from `compileExpansionChildJson`: JSONB timestamp
// strings back to `Date`, empty link properties dropped (matching the fallback),
// and nested links recursed.
function reviveExpandedRow(value: unknown): ExpandedObjectRow {
  const row = isPlainRecord(value) ? value : {}
  const expanded: ExpandedObjectRow = {
    projectId: String(row.projectId),
    objectTypeId: String(row.objectTypeId),
    primaryId: String(row.primaryId),
    properties: isPlainRecord(row.properties) ? row.properties : {},
    createdAt: new Date(row.createdAt as string),
    updatedAt: new Date(row.updatedAt as string),
    version: Number(row.version),
  }
  if (row.sourceEventId != null) expanded.sourceEventId = String(row.sourceEventId)
  if (row.lastCommitId != null) expanded.lastCommitId = String(row.lastCommitId)
  if (isPlainRecord(row.linkProperties) && Object.keys(row.linkProperties).length > 0) {
    expanded.linkProperties = row.linkProperties
  }
  const links = reviveExpandedLinks(row.links)
  if (links) expanded.links = links
  return expanded
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
    lastCommitId: row.last_commit_id ?? undefined,
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
  last_commit_id: string | null
}

interface ObjectQueryDatabaseRow extends ObjectDatabaseRow {
  _cursor_properties?: unknown
  /** `jsonb_build_object(linkId, value, ...)` from an `expand` pushdown; absent otherwise. */
  _expand?: unknown
}

interface FacetDatabaseRow {
  value_type: string | null
  value_text: string | null
  count: string | number | bigint
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
  last_commit_id: string | null
}
