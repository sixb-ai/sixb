import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  LinkDirection,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectRow,
  ObjectStorage,
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "@sixb/core"
import { installFreshSqliteSchema } from "./migrations"

export interface SqliteObjectStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

const SQLITE_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
  queryObjects: false,
  notes: ["SQLite object query pushdown is added in a later stacked PR."],
}

/**
 * SQLite-based ObjectStorage implementation.
 *
 * Stores object projections and links with full query support.
 */
export class SqliteObjectStorage implements ObjectStorage {
  private readonly db: Database

  constructor(options: SqliteObjectStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
      installFreshSqliteSchema(this.db)
    }
  }

  queryCapabilities(): ObjectQueryCapabilities {
    return SQLITE_OBJECT_QUERY_CAPABILITIES
  }

  async applyObjectUpserted(event: StoredObjectUpsertedEvent): Promise<ObjectRow> {
    // Check idempotency
    const applied = this.db
      .query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      .get(event.id)

    if (applied) {
      // Return existing row
      const existing = this.db
        .query(
          "SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
        )
        .get(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.primaryId
        ) as DatabaseRow | null

      if (existing) {
        return this.rowToObject(existing)
      }
    }

    const occurredAt = new Date(event.occurredAt)

    this.db.transaction(() => {
      // Get existing properties if any
      const existing = this.db
        .query(
          "SELECT properties, created_at, version FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
        )
        .get(event.projectId, event.payload.objectTypeId, event.payload.primaryId) as {
        properties: string
        created_at: string
        version: number
      } | null

      const existingProperties = existing ? JSON.parse(existing.properties) : {}
      const mergedProperties = { ...existingProperties, ...event.payload.properties }

      this.db
        .query(
          `
          INSERT INTO objects (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, source_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, object_type_id, primary_id) DO UPDATE SET
            properties = excluded.properties,
            updated_at = excluded.updated_at,
            version = excluded.version,
            source_event_id = excluded.source_event_id
        `
        )
        .run(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.primaryId,
          JSON.stringify(mergedProperties),
          existing?.created_at ?? occurredAt.toISOString(),
          occurredAt.toISOString(),
          (existing?.version ?? 0) + 1,
          event.id
        )

      this.db
        .query("INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)")
        .run(event.id)
    })()

    // Return the actual row from the database to include merged properties
    const row = this.db
      .query("SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?")
      .get(event.projectId, event.payload.objectTypeId, event.payload.primaryId) as DatabaseRow

    return this.rowToObject(row)
  }

  async applyObjectUpsertedBatch(
    events: readonly StoredObjectUpsertedEvent[]
  ): Promise<readonly ObjectRow[]> {
    if (events.length === 0) return []

    const results: ObjectRow[] = []

    this.db.transaction(() => {
      const checkApplied = this.db.query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      const getExisting = this.db.query(
        "SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
      )
      const getExistingProps = this.db.query(
        "SELECT properties, created_at, version FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
      )
      const upsertObject = this.db.query(`
        INSERT INTO objects (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, source_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, object_type_id, primary_id) DO UPDATE SET
          properties = excluded.properties,
          updated_at = excluded.updated_at,
          version = excluded.version,
          source_event_id = excluded.source_event_id
      `)
      const markApplied = this.db.query(
        "INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)"
      )

      for (const event of events) {
        const applied = checkApplied.get(event.id)
        if (applied) {
          const existing = getExisting.get(
            event.projectId,
            event.payload.objectTypeId,
            event.payload.primaryId
          ) as DatabaseRow | null
          if (existing) {
            results.push(this.rowToObject(existing))
          }
          continue
        }

        const occurredAt = new Date(event.occurredAt)
        const existing = getExistingProps.get(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.primaryId
        ) as { properties: string; created_at: string; version: number } | null

        const existingProperties = existing ? JSON.parse(existing.properties) : {}
        const mergedProperties = { ...existingProperties, ...event.payload.properties }

        upsertObject.run(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.primaryId,
          JSON.stringify(mergedProperties),
          existing?.created_at ?? occurredAt.toISOString(),
          occurredAt.toISOString(),
          (existing?.version ?? 0) + 1,
          event.id
        )

        markApplied.run(event.id)

        const row = getExisting.get(
          event.projectId,
          event.payload.objectTypeId,
          event.payload.primaryId
        ) as DatabaseRow
        results.push(this.rowToObject(row))
      }
    })()

    return results
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    // Check idempotency
    const applied = this.db
      .query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      .get(event.id)

    if (applied) return

    this.db.transaction(() => {
      // Get current object
      const existing = this.db
        .query(
          "SELECT properties FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
        )
        .get(event.projectId, event.payload.objectTypeId, event.payload.objectId) as {
        properties: string
      } | null

      if (!existing) return

      const properties = JSON.parse(existing.properties)
      properties[event.payload.propertyId] = event.payload.value

      this.db
        .query(
          `
          UPDATE objects
          SET properties = ?, updated_at = ?, version = version + 1, source_event_id = ?
          WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
        `
        )
        .run(
          JSON.stringify(properties),
          event.payload.at,
          event.id,
          event.projectId,
          event.payload.objectTypeId,
          event.payload.objectId
        )

      this.db
        .query("INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)")
        .run(event.id)
    })()
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    if (events.length === 0) return

    this.db.transaction(() => {
      const checkApplied = this.db.query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      const getProperties = this.db.query(
        "SELECT properties FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
      )
      const updateObject = this.db.query(`
        UPDATE objects
        SET properties = ?, updated_at = ?, version = version + 1, source_event_id = ?
        WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
      `)
      const markApplied = this.db.query(
        "INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)"
      )

      // Group events by unique object to minimize reads/writes
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
        if (checkApplied.get(event.id)) continue

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
        const existing = getProperties.get(group.projectId, group.objectTypeId, group.objectId) as {
          properties: string
        } | null

        if (!existing) continue

        const properties = JSON.parse(existing.properties)
        let latestAt = ""
        let latestEventId = ""

        for (const event of group.events) {
          properties[event.payload.propertyId] = event.payload.value
          if (event.payload.at > latestAt) {
            latestAt = event.payload.at
            latestEventId = event.id
          }
          markApplied.run(event.id)
        }

        updateObject.run(
          JSON.stringify(properties),
          latestAt,
          latestEventId,
          group.projectId,
          group.objectTypeId,
          group.objectId
        )
      }
    })()
  }

  async applyLinkUpserted(event: StoredLinkUpsertedEvent): Promise<void> {
    // Check idempotency
    const applied = this.db
      .query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      .get(event.id)

    if (applied) return

    const occurredAt = new Date(event.occurredAt)

    this.db
      .query(
        `
        INSERT INTO links (project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties, created_at, updated_at, source_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, source_type_id, source_id, link_id, target_type_id, target_id) DO UPDATE SET
          properties = excluded.properties,
          updated_at = excluded.updated_at,
          source_event_id = excluded.source_event_id
      `
      )
      .run(
        event.projectId,
        event.payload.sourceTypeId,
        event.payload.sourceId,
        event.payload.linkId,
        event.payload.targetTypeId,
        event.payload.targetId,
        event.payload.properties ? JSON.stringify(event.payload.properties) : null,
        occurredAt.toISOString(),
        occurredAt.toISOString(),
        event.id
      )

    this.db
      .query("INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)")
      .run(event.id)
  }

  async applyLinkUpsertedBatch(events: readonly StoredLinkUpsertedEvent[]): Promise<void> {
    if (events.length === 0) return

    this.db.transaction(() => {
      const checkApplied = this.db.query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      const upsertLink = this.db.query(`
        INSERT INTO links (project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties, created_at, updated_at, source_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, source_type_id, source_id, link_id, target_type_id, target_id) DO UPDATE SET
          properties = excluded.properties,
          updated_at = excluded.updated_at,
          source_event_id = excluded.source_event_id
      `)
      const markApplied = this.db.query(
        "INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)"
      )

      for (const event of events) {
        if (checkApplied.get(event.id)) continue

        const occurredAt = new Date(event.occurredAt)
        upsertLink.run(
          event.projectId,
          event.payload.sourceTypeId,
          event.payload.sourceId,
          event.payload.linkId,
          event.payload.targetTypeId,
          event.payload.targetId,
          event.payload.properties ? JSON.stringify(event.payload.properties) : null,
          occurredAt.toISOString(),
          occurredAt.toISOString(),
          event.id
        )
        markApplied.run(event.id)
      }
    })()
  }

  async applyLinkRemoved(event: StoredLinkRemovedEvent): Promise<void> {
    // Check idempotency
    const applied = this.db
      .query("SELECT 1 FROM applied_events_objects WHERE event_id = ?")
      .get(event.id)

    if (applied) return

    this.db
      .query(
        `
        DELETE FROM links
        WHERE project_id = ? AND source_type_id = ? AND source_id = ?
        AND link_id = ? AND target_type_id = ? AND target_id = ?
      `
      )
      .run(
        event.projectId,
        event.payload.sourceTypeId,
        event.payload.sourceId,
        event.payload.linkId,
        event.payload.targetTypeId,
        event.payload.targetId
      )

    this.db
      .query("INSERT OR IGNORE INTO applied_events_objects (event_id) VALUES (?)")
      .run(event.id)
  }

  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    const row = this.db
      .query("SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?")
      .get(params.projectId, params.objectTypeId, params.primaryId) as DatabaseRow | null

    return row ? this.rowToObject(row) : null
  }

  async findFirst(params: {
    projectId: string
    objectTypeId: string
    where?: readonly { propertyId: string; op: "eq"; value: unknown }[]
  }): Promise<ObjectRow | null> {
    const rows = this.db
      .query("SELECT * FROM objects WHERE project_id = ? AND object_type_id = ?")
      .all(params.projectId, params.objectTypeId) as DatabaseRow[]

    for (const row of rows) {
      const properties = JSON.parse(row.properties)

      if (params.where && params.where.length > 0) {
        const matches = params.where.every(
          (clause) => clause.op === "eq" && properties[clause.propertyId] === clause.value
        )
        if (!matches) continue
      }

      return this.rowToObject(row)
    }

    return null
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
        ? "target_type_id = ? AND target_id = ?"
        : direction === "both"
          ? "((source_type_id = ? AND source_id = ?) OR (target_type_id = ? AND target_id = ?))"
          : "source_type_id = ? AND source_id = ?"
    let query = `SELECT * FROM links WHERE project_id = ? AND ${directionWhere}`
    const args: (string | number)[] =
      direction === "both"
        ? [
            params.projectId,
            params.objectTypeId,
            params.objectId,
            params.objectTypeId,
            params.objectId,
          ]
        : [params.projectId, params.objectTypeId, params.objectId]

    if (params.linkId) {
      query += " AND link_id = ?"
      args.push(params.linkId)
    }

    const rows = this.db.query(query).all(...args) as LinkDatabaseRow[]

    return rows.map((row) => this.rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>> {
    const result = new Map<string, ObjectRow>()
    if (params.items.length === 0) return result

    const stmt = this.db.query(
      "SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
    )
    for (const item of params.items) {
      const row = stmt.get(
        params.projectId,
        item.objectTypeId,
        item.primaryId
      ) as DatabaseRow | null
      if (row) {
        result.set(`${item.objectTypeId}:${item.primaryId}`, this.rowToObject(row))
      }
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>> {
    const result = new Map<string, ObjectLinkRow[]>()
    if (params.items.length === 0) return result

    const stmt = this.db.query(
      "SELECT * FROM links WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?"
    )
    for (const item of params.items) {
      const rows = stmt.all(
        params.projectId,
        item.objectTypeId,
        item.objectId,
        item.linkId
      ) as LinkDatabaseRow[]
      if (rows.length > 0) {
        result.set(
          `${item.objectTypeId}:${item.objectId}:${item.linkId}`,
          rows.map((r) => this.rowToLink(r))
        )
      }
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
    let query = "SELECT * FROM objects WHERE project_id = ?"
    const args: (string | number | null)[] = [params.projectId]

    if (params.objectTypeId) {
      if (typeof params.objectTypeId === "string") {
        query += " AND object_type_id = ?"
        args.push(params.objectTypeId)
      } else {
        query += ` AND object_type_id IN (${params.objectTypeId.map(() => "?").join(", ")})`
        args.push(...params.objectTypeId)
      }
    }

    if (params.primaryIdPrefix) {
      query += " AND primary_id LIKE ?"
      args.push(`${params.primaryIdPrefix}%`)
    }

    if (params.primaryIdSuffix) {
      query += " AND primary_id LIKE ?"
      args.push(`%${params.primaryIdSuffix}`)
    }

    if (params.updatedAfter) {
      query += " AND updated_at >= ?"
      args.push(params.updatedAfter.toISOString())
    }

    if (params.updatedBefore) {
      query += " AND updated_at <= ?"
      args.push(params.updatedBefore.toISOString())
    }

    if (params.createdAfter) {
      query += " AND created_at >= ?"
      args.push(params.createdAfter.toISOString())
    }

    if (params.createdBefore) {
      query += " AND created_at <= ?"
      args.push(params.createdBefore.toISOString())
    }

    // Get total count
    const countResult = this.db.query(`SELECT COUNT(*) as total FROM (${query})`).get(...args) as {
      total: number
    }
    const total = countResult.total

    const offset = params.offset ?? 0
    const limit = params.limit ?? 50
    if (limit === 0) return { objects: [], hasMore: offset < total, total }

    // Add ordering
    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"
    const orderColumn =
      orderBy === "primaryId" ? "primary_id" : orderBy === "createdAt" ? "created_at" : "updated_at"
    query += ` ORDER BY ${orderColumn} ${order.toUpperCase()}`

    // Add pagination
    query += " LIMIT ? OFFSET ?"
    args.push(limit + 1, offset) // +1 to check for hasMore

    const rows = this.db.query(query).all(...args) as DatabaseRow[]
    const hasMore = rows.length > limit
    const objects = rows.slice(0, limit).map((row) => this.rowToObject(row))

    return { objects, hasMore, total }
  }
  private rowToObject(row: DatabaseRow): ObjectRow {
    return {
      projectId: row.project_id,
      objectTypeId: row.object_type_id,
      primaryId: row.primary_id,
      properties: JSON.parse(row.properties),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      version: row.version,
      sourceEventId: row.source_event_id ?? undefined,
    }
  }

  private rowToLink(row: LinkDatabaseRow): ObjectLinkRow {
    return {
      projectId: row.project_id,
      sourceTypeId: row.source_type_id,
      sourceId: row.source_id,
      linkId: row.link_id,
      targetTypeId: row.target_type_id,
      targetId: row.target_id,
      properties: row.properties ? JSON.parse(row.properties) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
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
  primary_id: string
  properties: string
  created_at: string
  updated_at: string
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
  properties: string | null
  created_at: string
  updated_at: string
  source_event_id: string | null
}
