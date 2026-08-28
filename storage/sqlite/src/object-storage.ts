import type { Database } from "bun:sqlite"
import type { ObjectQuery } from "@sixb/core"
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
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectRow,
  ObjectRowLinks,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { type CompiledObjectQuery, compileObjectQuery } from "./object-query-compiler"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteObjectStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

const SQLITE_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
  queryObjects: true,
  countObjects: true,
  existsObjects: true,
  facetObjects: true,
  nodes: {
    start: true,
    refs: true,
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
  scalarOperations: {
    string: { equality: true, ordering: true },
    uuid: { equality: true, ordering: true },
    boolean: { equality: true },
    integer: { equality: true, ordering: true },
    double: { equality: true, ordering: true },
    decimal: { equality: true },
    date: { equality: true, ordering: true },
    timestamp: { equality: true, ordering: true },
  },
  limits: {
    totalCount: true,
    stablePageTokens: true,
  },
  notes: [
    "SQLite object query pushdown supports start/refs/filter/text/sort/limit/page/traverse/set/project/expand over JSON properties and object links.",
    "expand hydrates linked objects in-database (top-N per parent via row_number() + json_group_array); core resolves each expansion's cardinality before pushdown, and a mixed/unresolved one stays on the fallback.",
    "Ordered decimal predicates and sorting use the bounded core fallback because SQLite has no native exact decimal type; canonical decimal equality remains pushdown-safe.",
    "Relevance sorting, vector search, and unresolved start.includeSubtypes remain planner fallback or rejection cases.",
  ],
}

/**
 * SQLite-based ObjectStorage implementation.
 *
 * Stores object projections and links. V1 object-query IR pushdown covers the
 * scalar JSON-property and link-traversal subset declared by queryCapabilities().
 */
export class SqliteObjectStorage implements ObjectStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteObjectStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  queryCapabilities(): ObjectQueryCapabilities {
    return SQLITE_OBJECT_QUERY_CAPABILITIES
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    const compiled = compileObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
    })
    const total = params.includeTotal === false ? undefined : readTotal(this.db, compiled)
    const rawRows = this.db.query(compiled.sql).all(...compiled.args) as ObjectQueryDatabaseRow[]
    const rows = compiled.trimRows(rawRows) as readonly ObjectQueryDatabaseRow[]
    const hasMore =
      total === undefined && compiled.hasMoreProbe
        ? compiled.hasMoreProbe.hasMore(
            this.db.query(compiled.hasMoreProbe.sql).all(...compiled.hasMoreProbe.args).length
          )
        : compiled.hasMore(rawRows.length, total)

    return {
      objects: rows.map((row) => this.queryRowToObject(row)),
      hasMore,
      nextPageToken: compiled.nextPageToken(rows, rawRows.length),
      ...(total === undefined ? {} : { total }),
    }
  }

  async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    return {
      count: readTotal(
        this.db,
        compileObjectQuery(params.projectId, stripOuterRowShape(params.query))
      ),
    }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    const compiled = compileObjectQuery(params.projectId, existsProbeQuery(params.query))
    return { exists: this.db.query(compiled.sql).get(...compiled.args) !== null }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    const compiled = compileObjectQuery(params.projectId, stripOuterRowShape(params.query))
    return {
      facets: params.facets.map((facet) => ({
        propertyId: facet.propertyId,
        buckets: readFacetBuckets(this.db, compiled, facet),
      })),
    }
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

    const rows = this.db
      .query(
        `
          SELECT object.*
          FROM json_each(?) AS requested
          JOIN objects AS object
            ON object.project_id = ?
           AND object.object_type_id = json_extract(requested.value, '$.objectTypeId')
           AND object.primary_id = json_extract(requested.value, '$.primaryId')
        `
      )
      .all(JSON.stringify(params.items), params.projectId) as DatabaseRow[]
    for (const row of rows) {
      result.set(`${row.object_type_id}:${row.primary_id}`, this.rowToObject(row))
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

  async listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]> {
    if (params.items.length === 0) return []

    const rows = this.db
      .query(
        `
          WITH requested AS (
            SELECT
              json_extract(value, '$.objectTypeId') AS object_type_id,
              json_extract(value, '$.objectId') AS object_id
            FROM json_each(?)
          )
          SELECT link.*
          FROM links AS link
          JOIN requested
            ON requested.object_type_id = link.source_type_id
           AND requested.object_id = link.source_id
          WHERE link.project_id = ?
          UNION
          SELECT link.*
          FROM links AS link
          JOIN requested
            ON requested.object_type_id = link.target_type_id
           AND requested.object_id = link.target_id
          WHERE link.project_id = ?
        `
      )
      .all(JSON.stringify(params.items), params.projectId, params.projectId) as LinkDatabaseRow[]

    const deduped = new Map<string, ObjectLinkRow>()
    for (const row of rows) {
      const link = this.rowToLink(row)
      deduped.set(linkIdentity(link), link)
    }
    return [...deduped.values()]
  }

  async listByPrimaryIdPage(params: {
    projectId: string
    objectTypeId: string
    afterPrimaryId?: string
    limit: number
  }): Promise<{ objects: readonly ObjectRow[]; nextPrimaryId?: string }> {
    assertReconciliationPageLimit(params.limit)
    const rows = this.db
      .query(
        `
          SELECT * FROM objects
          WHERE project_id = ? AND object_type_id = ?
            AND (? IS NULL OR primary_id > ?)
          ORDER BY primary_id ASC
          LIMIT ?
        `
      )
      .all(
        params.projectId,
        params.objectTypeId,
        params.afterPrimaryId ?? null,
        params.afterPrimaryId ?? null,
        params.limit + 1
      ) as DatabaseRow[]
    const hasMore = rows.length > params.limit
    const objects = rows.slice(0, params.limit).map((row) => this.rowToObject(row))
    const last = objects.at(-1)
    return {
      objects,
      ...(hasMore && last ? { nextPrimaryId: last.primaryId } : {}),
    }
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
      lastCommitId: row.last_commit_id,
    }
  }

  // Map a query row, attaching `links` when an `expand` pushdown produced them.
  // The base columns map as usual; `_expand` (a `json_object` serialized to TEXT)
  // is parsed and revived into the runtime link shape the core executor's
  // fallback also produces.
  private queryRowToObject(row: ObjectQueryDatabaseRow): ObjectRow {
    const base = this.rowToObject(row)
    const links = reviveExpandedLinks(parseExpandColumn(row._expand))
    return links ? { ...base, links } : base
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

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}

function linkIdentity(link: ObjectLinkRow): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

function readTotal(db: Database, compiled: CompiledObjectQuery): number {
  const row = db.query(compiled.totalSql).get(...compiled.totalArgs) as { total: number }
  return row.total
}

function readFacetBuckets(
  db: Database,
  compiled: CompiledObjectQuery,
  facet: ObjectFacetRequest
): { value: unknown; count: number }[] {
  const path = sqliteJsonPath(facet.propertyId)
  const rows = db
    .query(
      `
      SELECT
        json_type(input.properties, ?) AS value_type,
        json_extract(input.properties, ?) AS value,
        COUNT(*) AS count
      FROM (${compiled.sql}) AS input
      WHERE json_type(input.properties, ?) IS NOT NULL
      GROUP BY value_type, value
      ORDER BY count DESC, CAST(value AS TEXT) ASC
      LIMIT ?
    `
    )
    .all(path, path, ...compiled.args, path, facet.limit) as FacetDatabaseRow[]

  return rows.map((row) => ({
    value: sqliteFacetValue(row.value_type, row.value),
    count: Number(row.count),
  }))
}

function sqliteJsonPath(propertyId: string): string {
  return `$."${propertyId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function sqliteFacetValue(valueType: string | null, value: unknown): unknown {
  if (valueType === "true") return true
  if (valueType === "false") return false
  if (valueType === "null") return null
  return value
}

// The `_expand` column comes back from SQLite as a JSON string (or null/absent
// when the query carried no expansion); parse it before reviving.
function parseExpandColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? undefined
  return JSON.parse(value)
}

function reviveExpandedLinks(value: unknown): ObjectRowLinks | undefined {
  if (!isPlainObject(value)) return undefined
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

// Revive one hydrated neighbour from `compileExpansionChildJson`: timestamp
// strings back to `Date`, null/empty link properties dropped (matching the
// fallback), and nested links recursed.
function reviveExpandedRow(value: unknown): ExpandedObjectRow {
  const row = isPlainObject(value) ? value : {}
  const expanded: ExpandedObjectRow = {
    projectId: String(row.projectId),
    objectTypeId: String(row.objectTypeId),
    primaryId: String(row.primaryId),
    properties: isPlainObject(row.properties) ? row.properties : {},
    createdAt: new Date(row.createdAt as string),
    updatedAt: new Date(row.updatedAt as string),
    version: Number(row.version),
    lastCommitId: String(row.lastCommitId),
  }
  if (isPlainObject(row.linkProperties) && Object.keys(row.linkProperties).length > 0) {
    expanded.linkProperties = row.linkProperties
  }
  const links = reviveExpandedLinks(row.links)
  if (links) expanded.links = links
  return expanded
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function existsProbeQuery(query: ObjectQuery): ObjectQuery {
  return { kind: "limit", limit: 1, input: stripOuterRowShape(query) }
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

interface DatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: string
  created_at: string
  updated_at: string
  version: number
  last_commit_id: string
}

interface ObjectQueryDatabaseRow extends DatabaseRow {
  _cursor_properties?: string
  /** `json_object(linkId, value, ...)` serialized text from an `expand` pushdown; absent otherwise. */
  _expand?: string | null
}

interface FacetDatabaseRow {
  value_type: string | null
  value: unknown
  count: number
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
  last_commit_id: string
}
