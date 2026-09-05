import type { Database } from "bun:sqlite"
import type { ObjectQuery } from "@sixb/core"
import type {
  CompiledSelectedObjectReadScope,
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  ExpandedLinkValue,
  ExpandedObjectRow,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkBatchKey,
  LinkDirection,
  ObjectBatchKey,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
  ObjectRow,
  ObjectRowLinks,
  ObjectStorage,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import {
  assertObjectReaderProject,
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
  linkBatchKey,
  ObjectReadLimitExceededError,
  objectBatchKey,
  snapshotObjectReadExecutionLimits,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  type CompiledObjectQuery,
  compileObjectQuery,
  type SqliteObjectQuerySource,
  type SqliteValue,
} from "./object-query-compiler"
import {
  compileSqliteSelectedObjectReadSource,
  type SqliteSelectedObjectReadSource,
} from "./object-read-scope"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runDeferredReadTransaction,
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

  createSelectedReadScope(params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    const projectId = params.projectId
    const limits = snapshotObjectReadExecutionLimits(params.limits)
    const source = compileSqliteSelectedObjectReadSource(
      projectId,
      params.scope,
      limits.maxTraversalFacts
    )
    const assertProject = (actualProjectId: string): void =>
      assertObjectReaderProject(projectId, actualProjectId)
    const read = <T>(run: () => T): T =>
      runDeferredReadTransaction(this.db, () => {
        assertTraversalBudget(this.db, source, limits.maxTraversalFacts)
        const value = run()
        assertObjectReadOutputWithinLimit(value, limits)
        return value
      })
    const readMap = <TKey, TValue>(run: () => Map<TKey, TValue>): Map<TKey, TValue> =>
      runDeferredReadTransaction(this.db, () => {
        assertTraversalBudget(this.db, source, limits.maxTraversalFacts)
        const value = run()
        assertObjectReadOutputWithinLimit([...value.entries()], limits)
        return value
      })

    return Object.freeze({
      queryCapabilities: () => this.queryCapabilities(),
      queryObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.queryObjectsFromSource(input, source))
      },
      countObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.countObjectsFromSource(input, source))
      },
      existsObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.existsObjectsFromSource(input, source))
      },
      facetObjects: async (input) => {
        assertProject(input.projectId)
        assertObjectReadFacetCount(input.facets.length)
        return read(() => this.facetObjectsFromSource(input, source))
      },
      getByPrimaryId: async (input) => {
        assertProject(input.projectId)
        return read(() => this.getByPrimaryIdFromSource(input, source))
      },
      selectsObjectProperties: async (input) => {
        assertProject(input.projectId)
        return read(() => this.selectsObjectPropertiesFromSource(input, source))
      },
      listLinks: async (input) => {
        assertProject(input.projectId)
        return read(() => this.listLinksFromSource(input, source))
      },
      getByPrimaryIdBatch: async (input) => {
        assertProject(input.projectId)
        return readMap(() => this.getByPrimaryIdBatchFromSource(input, source))
      },
      listLinksBatch: async (input) => {
        assertProject(input.projectId)
        return readMap(() => this.listLinksBatchFromSource(input, source))
      },
      queryLinks: async (input) => {
        assertProject(input.projectId)
        assertLinkQueryLimit(input.limit)
        return read(() => this.queryLinksFromSource(input, source))
      },
      list: async (input) => {
        assertProject(input.projectId)
        return read(() => this.listFromSource(input, source))
      },
    } satisfies ObjectReadStorage)
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    return this.queryObjectsFromSource(params)
  }

  private queryObjectsFromSource(
    params: QueryObjectsInput,
    source?: SqliteObjectQuerySource
  ): QueryObjectsResult {
    const compiled = compileObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      ...(source ? { source } : {}),
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
    return this.countObjectsFromSource(params)
  }

  private countObjectsFromSource(
    params: CountObjectsInput,
    source?: SqliteObjectQuerySource
  ): CountObjectsResult {
    return {
      count: readTotal(
        this.db,
        compileObjectQuery(params.projectId, stripOuterRowShape(params.query), {
          ...(source ? { source } : {}),
        })
      ),
    }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return this.existsObjectsFromSource(params)
  }

  private existsObjectsFromSource(
    params: ExistsObjectsInput,
    source?: SqliteObjectQuerySource
  ): ExistsObjectsResult {
    const compiled = compileObjectQuery(params.projectId, existsProbeQuery(params.query), {
      ...(source ? { source } : {}),
    })
    return { exists: this.db.query(compiled.sql).get(...compiled.args) !== null }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return this.facetObjectsFromSource(params)
  }

  private facetObjectsFromSource(
    params: FacetObjectsInput,
    source?: SqliteObjectQuerySource
  ): FacetObjectsResult {
    const compiled = compileObjectQuery(params.projectId, stripOuterRowShape(params.query), {
      ...(source ? { source } : {}),
    })
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
    return this.getByPrimaryIdFromSource(params)
  }

  private getByPrimaryIdFromSource(
    params: {
      projectId: string
      objectTypeId: string
      primaryId: string
    },
    source?: SqliteObjectQuerySource
  ): ObjectRow | null {
    const objectsTable = source?.objectsTable ?? "objects"
    const statement = wrapSourceStatement(
      source,
      `SELECT * FROM ${objectsTable} WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`,
      [params.projectId, params.objectTypeId, params.primaryId]
    )
    const row = this.db.query(statement.sql).get(...statement.args) as DatabaseRow | null

    return row ? this.rowToObject(row) : null
  }

  async selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): Promise<readonly boolean[]> {
    return this.selectsObjectPropertiesFromSource(params)
  }

  private selectsObjectPropertiesFromSource(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0],
    source?: SqliteSelectedObjectReadSource
  ): readonly boolean[] {
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const requestedType = "CAST(json_extract(requested.value, '$.objectTypeId') AS TEXT)"
    const requestedId = "CAST(json_extract(requested.value, '$.primaryId') AS TEXT)"
    const requestedProperty = "CAST(json_extract(requested.value, '$.propertyId') AS TEXT)"
    const storedTable = source?.objectPropertyPermissionsTable ?? "objects"
    const propertyJoin = source ? `AND stored.property_id = ${requestedProperty}` : ""
    const statement = wrapSourceStatement(
      source,
      `SELECT DISTINCT
         CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
       FROM ${storedTable} AS stored
       JOIN json_each(?) AS requested
         ON stored.object_type_id = ${requestedType}
        AND stored.primary_id = ${requestedId}
        ${propertyJoin}
       WHERE stored.project_id = ?`,
      [JSON.stringify(items), params.projectId]
    )
    const rows = this.db
      .query(statement.sql)
      .all(...statement.args) as PropertyPermissionBatchDatabaseRow[]
    for (const row of rows) result[row._batch_index] = true
    return result
  }

  async listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]> {
    return this.listLinksFromSource(params)
  }

  private listLinksFromSource(
    params: {
      projectId: string
      objectTypeId: string
      objectId: string
      linkId?: string
      direction?: LinkDirection
    },
    source?: SqliteObjectQuerySource
  ): readonly ObjectLinkRow[] {
    const direction = params.direction ?? "outgoing"
    const directionWhere =
      direction === "incoming"
        ? "target_type_id = ? AND target_id = ?"
        : direction === "both"
          ? "((source_type_id = ? AND source_id = ?) OR (target_type_id = ? AND target_id = ?))"
          : "source_type_id = ? AND source_id = ?"
    let query = `SELECT * FROM ${source?.linksTable ?? "links"} WHERE project_id = ? AND ${directionWhere}`
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

    const statement = wrapSourceStatement(source, query, args)
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkDatabaseRow[]

    return rows.map((row) => this.rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<ObjectBatchKey, ObjectRow>> {
    return this.getByPrimaryIdBatchFromSource(params)
  }

  private getByPrimaryIdBatchFromSource(
    params: {
      projectId: string
      items: readonly { objectTypeId: string; primaryId: string }[]
    },
    source?: SqliteObjectQuerySource
  ): Map<ObjectBatchKey, ObjectRow> {
    const result = new Map<ObjectBatchKey, ObjectRow>()
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = wrapSourceStatement(
      source,
      `
        SELECT
          object.*,
          CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
        FROM json_each(?) AS requested
        JOIN ${source?.objectsTable ?? "objects"} AS object
          ON object.project_id = ?
         AND object.object_type_id = json_extract(requested.value, '$.objectTypeId')
         AND object.primary_id = json_extract(requested.value, '$.primaryId')
      `,
      [JSON.stringify(items), params.projectId]
    )
    const rows = this.db.query(statement.sql).all(...statement.args) as ObjectBatchDatabaseRow[]
    const rowsByIndex = new Map(rows.map((row) => [row._batch_index, row]))
    for (const [index, item] of params.items.entries()) {
      const row = rowsByIndex.get(index)
      if (row) result.set(objectBatchKey(item.objectTypeId, item.primaryId), this.rowToObject(row))
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    return this.listLinksBatchFromSource(params)
  }

  private listLinksBatchFromSource(
    params: {
      projectId: string
      direction?: LinkDirection
      items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
    },
    source?: SqliteObjectQuerySource
  ): Map<LinkBatchKey, ObjectLinkRow[]> {
    const result = new Map<LinkBatchKey, ObjectLinkRow[]>()
    if (params.items.length === 0) return result

    const direction = params.direction ?? "outgoing"
    const requestedType = "CAST(json_extract(requested.value, '$.objectTypeId') AS TEXT)"
    const requestedId = "CAST(json_extract(requested.value, '$.objectId') AS TEXT)"
    const requestedLink = "CAST(json_extract(requested.value, '$.linkId') AS TEXT)"
    const outgoing = `stored.source_type_id = ${requestedType} AND stored.source_id = ${requestedId}`
    const incoming = `stored.target_type_id = ${requestedType} AND stored.target_id = ${requestedId}`
    const directionJoin =
      direction === "both"
        ? `((${outgoing}) OR (${incoming}))`
        : direction === "incoming"
          ? incoming
          : outgoing
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = wrapSourceStatement(
      source,
      `
        SELECT
          stored.*,
          CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
        FROM ${source?.linksTable ?? "links"} AS stored
        JOIN json_each(?) AS requested
          ON ${directionJoin}
         AND stored.link_id = ${requestedLink}
        WHERE stored.project_id = ?
        ORDER BY _batch_index, source_type_id, source_id, link_id, target_type_id, target_id
      `,
      [JSON.stringify(items), params.projectId]
    )
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkBatchDatabaseRow[]
    const rowsByIndex = params.items.map(() => new Map<string, ObjectLinkRow>())
    for (const row of rows) {
      const link = this.rowToLink(row)
      rowsByIndex[row._batch_index]?.set(fullLinkIdentity(link), link)
    }
    for (const [index, item] of params.items.entries()) {
      const links = [...(rowsByIndex[index]?.values() ?? [])]
      if (links.length > 0) {
        result.set(linkBatchKey(item.objectTypeId, item.objectId, item.linkId), links)
      }
    }
    return result
  }

  async queryLinks(params: QueryObjectLinksInput): Promise<QueryObjectLinksResult> {
    assertLinkQueryLimit(params.limit)
    return this.queryLinksFromSource(params)
  }

  private queryLinksFromSource(
    params: QueryObjectLinksInput,
    source?: SqliteObjectQuerySource
  ): QueryObjectLinksResult {
    if (params.objectRefs.length === 0 || params.endpointObjectTypeIds?.length === 0) {
      return { links: [], hasMore: false }
    }

    const requested = `
      SELECT DISTINCT
        json_extract(value, '$.objectTypeId') AS object_type_id,
        json_extract(value, '$.primaryId') AS object_id
      FROM json_each(?)
    `
    const linksTable = source?.linksTable ?? "links"
    const sourceJoin = `
      SELECT link.*
      FROM ${linksTable} AS link
      JOIN (${requested}) AS requested
        ON requested.object_type_id = link.source_type_id
       AND requested.object_id = link.source_id
      WHERE link.project_id = ?
    `
    const targetJoin = `
      SELECT link.*
      FROM ${linksTable} AS link
      JOIN (${requested}) AS requested
        ON requested.object_type_id = link.target_type_id
       AND requested.object_id = link.target_id
      WHERE link.project_id = ?
    `
    const incidentSql =
      params.direction === "outgoing"
        ? sourceJoin
        : params.direction === "incoming"
          ? targetJoin
          : `${sourceJoin} UNION ${targetJoin}`
    const requestedJson = JSON.stringify(params.objectRefs)
    const args: (string | number)[] =
      params.direction === "both"
        ? [requestedJson, params.projectId, requestedJson, params.projectId]
        : [requestedJson, params.projectId]

    const predicates: string[] = []
    if (params.linkId !== undefined) {
      predicates.push("link_id = ?")
      args.push(params.linkId)
    }
    if (params.endpointObjectTypeIds !== undefined) {
      const allowedTypes = JSON.stringify([...new Set(params.endpointObjectTypeIds)])
      predicates.push(
        "source_type_id IN (SELECT value FROM json_each(?))",
        "target_type_id IN (SELECT value FROM json_each(?))"
      )
      args.push(allowedTypes, allowedTypes)
    }
    if (params.after) {
      predicates.push(
        "(source_type_id, source_id, link_id, target_type_id, target_id) > (?, ?, ?, ?, ?)"
      )
      args.push(...params.after)
    }
    args.push(params.limit + 1)

    const whereSql = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""
    const statement = wrapSourceStatement(
      source,
      `
        SELECT *
        FROM (${incidentSql}) AS incident
        ${whereSql}
        ORDER BY source_type_id, source_id, link_id, target_type_id, target_id
        LIMIT ?
      `,
      args
    )
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkDatabaseRow[]

    return {
      links: rows.slice(0, params.limit).map((row) => this.rowToLink(row)),
      hasMore: rows.length > params.limit,
    }
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

    return rows.map((row) => this.rowToLink(row))
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
    return this.listFromSource(params)
  }

  private listFromSource(
    params: Parameters<ObjectReadStorage["list"]>[0],
    source?: SqliteObjectQuerySource
  ): { objects: readonly ObjectRow[]; hasMore: boolean; total: number } {
    let query = `SELECT * FROM ${source?.objectsTable ?? "objects"} WHERE project_id = ?`
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
    const countStatement = wrapSourceStatement(
      source,
      `SELECT COUNT(*) as total FROM (${query}) AS filtered_objects`,
      args
    )
    const countResult = this.db.query(countStatement.sql).get(...countStatement.args) as {
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

    const rowsStatement = wrapSourceStatement(source, query, args)
    const rows = this.db.query(rowsStatement.sql).all(...rowsStatement.args) as DatabaseRow[]
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
      ...(row.properties === null ? {} : { properties: JSON.parse(row.properties) }),
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

function wrapSourceStatement(
  source: SqliteObjectQuerySource | undefined,
  sql: string,
  args: readonly SqliteValue[] = []
): { readonly sql: string; readonly args: readonly SqliteValue[] } {
  return source?.wrapStatement(sql, args) ?? { sql, args }
}

function assertTraversalBudget(
  db: Database,
  source: SqliteSelectedObjectReadSource,
  maxTraversalFacts: number
): void {
  const row = db.query(source.traversalProbe.sql).get(...source.traversalProbe.args) as {
    total: number | bigint
  }
  if (BigInt(row.total) > BigInt(maxTraversalFacts)) {
    throw new ObjectReadLimitExceededError("traversalFacts", maxTraversalFacts)
  }
}

function fullLinkIdentity(link: ObjectLinkRow): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}

function assertLinkQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object link query limit must be a positive safe integer.")
  }
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

interface ObjectBatchDatabaseRow extends DatabaseRow {
  _batch_index: number
}

interface PropertyPermissionBatchDatabaseRow {
  _batch_index: number
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

interface LinkBatchDatabaseRow extends LinkDatabaseRow {
  _batch_index: number
}
