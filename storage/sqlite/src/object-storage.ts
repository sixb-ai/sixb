import type { Database } from "bun:sqlite"
import type { ObjectQuery } from "@sixb/core"
import type {
  CompiledObjectReadScope,
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  ExpandedLinkValue,
  ExpandedObjectRow,
  FacetObjectsInput,
  FacetObjectsResult,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadScope,
  ObjectReadStorage,
  ObjectRow,
  ObjectRowLinks,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import {
  assertObjectReaderProject,
  assertVisibleJsonWithinLimit,
  compileObjectReadScope,
  DelegatedExecutionLimitError,
  MAX_OBJECT_FACETS_PER_READ,
  normalizeObjectListWindow,
  objectListHasMore,
  objectListLookaheadLimit,
  snapshotObjectReadExecutionLimits,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  type CompiledObjectQuery,
  compileObjectQuery,
  compileSqliteObjectReadScopeTraversalProbe,
  compileSqliteObjectReadSource,
} from "./object-query-compiler"
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

const ALL_OBJECT_READ_SCOPE: CompiledObjectReadScope = { kind: "all" }

type GetObjectInput = Parameters<ObjectReadStorage["getByPrimaryId"]>[0]
type SelectsObjectPropertiesInput = Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
type ListLinksInput = Parameters<ObjectReadStorage["listLinks"]>[0]
type GetObjectsManyInput = Parameters<ObjectReadStorage["getByPrimaryIdMany"]>[0]
type ListLinksManyInput = Parameters<ObjectReadStorage["listLinksMany"]>[0]
type GetObjectsBatchInput = Parameters<ObjectStorage["getByPrimaryIdBatch"]>[0]
type ListLinksBatchInput = Parameters<ObjectStorage["listLinksBatch"]>[0]
type ListObjectsInput = Parameters<ObjectReadStorage["list"]>[0]

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

  createReadScope(params: {
    projectId: string
    scope: ObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    const projectId = params.projectId
    const scope = compileObjectReadScope(params.scope)
    const limits = snapshotObjectReadExecutionLimits(params.limits)
    const traversalProbe =
      scope.kind === "selected"
        ? compileSqliteObjectReadScopeTraversalProbe(projectId, scope, limits.maxTraversalFacts)
        : undefined
    const assertProject = (actualProjectId: string) =>
      assertObjectReaderProject(projectId, actualProjectId)
    const read = <T>(run: () => T): T =>
      runReadSnapshot(this.db, () => {
        assertTraversalBudget(this.db, traversalProbe, limits)
        const value = run()
        assertVisibleJsonWithinLimit(value, limits)
        return value
      })

    const reader: ObjectReadStorage = {
      queryCapabilities: () => this.queryCapabilities(),
      queryObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.queryObjectsWithScope(input, scope))
      },
      countObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.countObjectsWithScope(input, scope))
      },
      existsObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.existsObjectsWithScope(input, scope))
      },
      facetObjects: async (input) => {
        assertProject(input.projectId)
        return read(() => this.facetObjectsWithScope(input, scope))
      },
      getByPrimaryId: async (input) => {
        assertProject(input.projectId)
        return read(() => this.getByPrimaryIdWithScope(input, scope))
      },
      selectsObjectProperties: async (input) => {
        assertProject(input.projectId)
        return read(() => this.selectsObjectPropertiesWithScope(input, scope))
      },
      listLinks: async (input) => {
        assertProject(input.projectId)
        return read(() => this.listLinksWithScope(input, scope))
      },
      getByPrimaryIdMany: async (input) => {
        assertProject(input.projectId)
        return read(() => this.getByPrimaryIdManyWithScope(input, scope))
      },
      listLinksMany: async (input) => {
        assertProject(input.projectId)
        return read(() => this.listLinksManyWithScope(input, scope))
      },
      list: async (input) => {
        assertProject(input.projectId)
        return read(() => this.listWithScope(input, scope))
      },
    }
    return Object.freeze(reader)
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    return this.queryObjectsWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private queryObjectsWithScope(
    params: QueryObjectsInput,
    scope: CompiledObjectReadScope
  ): QueryObjectsResult {
    const compiled = compileObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      scope,
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
    return this.countObjectsWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private countObjectsWithScope(
    params: CountObjectsInput,
    scope: CompiledObjectReadScope
  ): CountObjectsResult {
    return {
      count: readTotal(
        this.db,
        compileObjectQuery(params.projectId, stripOuterRowShape(params.query), { scope })
      ),
    }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return this.existsObjectsWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private existsObjectsWithScope(
    params: ExistsObjectsInput,
    scope: CompiledObjectReadScope
  ): ExistsObjectsResult {
    const compiled = compileObjectQuery(params.projectId, existsProbeQuery(params.query), { scope })
    return { exists: this.db.query(compiled.sql).get(...compiled.args) !== null }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return this.facetObjectsWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private facetObjectsWithScope(
    params: FacetObjectsInput,
    scope: CompiledObjectReadScope
  ): FacetObjectsResult {
    if (params.facets.length > MAX_OBJECT_FACETS_PER_READ) {
      throw new Error(
        `[SixbSqlite] A facet read supports at most ${MAX_OBJECT_FACETS_PER_READ} facets.`
      )
    }
    const compiled = compileObjectQuery(params.projectId, stripOuterRowShape(params.query), {
      scope,
    })
    return {
      facets: params.facets.map((facet) => ({
        propertyId: facet.propertyId,
        buckets: readFacetBuckets(this.db, compiled, facet),
      })),
    }
  }

  async getByPrimaryId(params: GetObjectInput): Promise<ObjectRow | null> {
    return this.getByPrimaryIdWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private getByPrimaryIdWithScope(
    params: GetObjectInput,
    scope: CompiledObjectReadScope
  ): ObjectRow | null {
    const source = compileSqliteObjectReadSource(params.projectId, scope)
    const statement = source.scopeStatement(
      `SELECT * FROM ${source.objectsTable} WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`,
      [params.projectId, params.objectTypeId, params.primaryId]
    )
    const row = this.db.query(statement.sql).get(...statement.args) as DatabaseRow | null

    return row ? this.rowToObject(row) : null
  }

  async selectsObjectProperties(params: SelectsObjectPropertiesInput): Promise<readonly boolean[]> {
    return this.selectsObjectPropertiesWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private selectsObjectPropertiesWithScope(
    params: SelectsObjectPropertiesInput,
    scope: CompiledObjectReadScope
  ): readonly boolean[] {
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const source = compileSqliteObjectReadSource(params.projectId, scope)
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const requestedType = "CAST(json_extract(requested.value, '$.objectTypeId') AS TEXT)"
    const requestedId = "CAST(json_extract(requested.value, '$.primaryId') AS TEXT)"
    const requestedProperty = "CAST(json_extract(requested.value, '$.propertyId') AS TEXT)"
    const storedTable = source.objectPropertyPermissionsTable ?? source.objectsTable
    const propertyJoin = source.objectPropertyPermissionsTable
      ? `AND stored.property_id = ${requestedProperty}`
      : ""
    const statement = source.scopeStatement(
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
    for (const row of rows) {
      result[row._batch_index] = true
    }
    return result
  }

  async listLinks(params: ListLinksInput): Promise<readonly ObjectLinkRow[]> {
    return this.listLinksWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private listLinksWithScope(
    params: ListLinksInput,
    scope: CompiledObjectReadScope
  ): readonly ObjectLinkRow[] {
    const source = compileSqliteObjectReadSource(params.projectId, scope)
    const direction = params.direction ?? "outgoing"
    const directionWhere =
      direction === "incoming"
        ? "target_type_id = ? AND target_id = ?"
        : direction === "both"
          ? "((source_type_id = ? AND source_id = ?) OR (target_type_id = ? AND target_id = ?))"
          : "source_type_id = ? AND source_id = ?"
    let query = `SELECT * FROM ${source.linksTable} WHERE project_id = ? AND ${directionWhere}`
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

    const statement = source.scopeStatement(query, args)
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkDatabaseRow[]

    return rows.map((row) => this.rowToLink(row))
  }

  async getByPrimaryIdMany(params: GetObjectsManyInput): Promise<readonly (ObjectRow | null)[]> {
    return this.getByPrimaryIdManyWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private getByPrimaryIdManyWithScope(
    params: GetObjectsManyInput,
    scope: CompiledObjectReadScope
  ): readonly (ObjectRow | null)[] {
    const result = params.items.map<ObjectRow | null>(() => null)
    if (params.items.length === 0) return result

    const source = compileSqliteObjectReadSource(params.projectId, scope)
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = source.scopeStatement(
      `SELECT
         stored.*,
         CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
       FROM ${source.objectsTable} AS stored
       JOIN json_each(?) AS requested
         ON stored.object_type_id = CAST(json_extract(requested.value, '$.objectTypeId') AS TEXT)
        AND stored.primary_id = CAST(json_extract(requested.value, '$.primaryId') AS TEXT)
       WHERE stored.project_id = ?`,
      [JSON.stringify(items), params.projectId]
    )
    const rows = this.db.query(statement.sql).all(...statement.args) as ObjectBatchDatabaseRow[]
    for (const row of rows) {
      result[row._batch_index] = this.rowToObject(row)
    }
    return result
  }

  async getByPrimaryIdBatch(params: GetObjectsBatchInput): Promise<Map<string, ObjectRow>> {
    const rows = await this.getByPrimaryIdManyWithScope(params, ALL_OBJECT_READ_SCOPE)
    return toLegacyObjectBatchMap(params.items, rows)
  }

  async listLinksMany(params: ListLinksManyInput): Promise<readonly (readonly ObjectLinkRow[])[]> {
    return this.listLinksManyWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private listLinksManyWithScope(
    params: ListLinksManyInput,
    scope: CompiledObjectReadScope
  ): readonly (readonly ObjectLinkRow[])[] {
    const result = params.items.map(() => new Map<string, ObjectLinkRow>())
    if (params.items.length === 0) return []

    const source = compileSqliteObjectReadSource(params.projectId, scope)
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
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
    const statement = source.scopeStatement(
      `SELECT
         stored.*,
         CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
       FROM ${source.linksTable} AS stored
       JOIN json_each(?) AS requested
         ON ${directionJoin}
        AND stored.link_id = ${requestedLink}
       WHERE stored.project_id = ?`,
      [JSON.stringify(items), params.projectId]
    )
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkBatchDatabaseRow[]
    for (const row of rows) {
      const link = this.rowToLink(row)
      result[row._batch_index].set(
        JSON.stringify([
          link.sourceTypeId,
          link.sourceId,
          link.linkId,
          link.targetTypeId,
          link.targetId,
        ]),
        link
      )
    }
    return result.map((links) => [...links.values()])
  }

  async listLinksBatch(params: ListLinksBatchInput): Promise<Map<string, ObjectLinkRow[]>> {
    const rows = await this.listLinksManyWithScope(params, ALL_OBJECT_READ_SCOPE)
    return toLegacyLinkBatchMap(params.items, rows)
  }

  async listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]> {
    const deduped = new Map<string, ObjectLinkRow>()
    for (const item of params.items) {
      const rows = await this.listLinks({
        projectId: params.projectId,
        objectTypeId: item.objectTypeId,
        objectId: item.objectId,
        direction: "both",
      })
      for (const row of rows) {
        deduped.set(fullLinkIdentity(row), row)
      }
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
        objectListLookaheadLimit(params.limit)
      ) as DatabaseRow[]
    const hasMore = rows.length > params.limit
    const objects = rows.slice(0, params.limit).map((row) => this.rowToObject(row))
    const last = objects.at(-1)
    return {
      objects,
      ...(hasMore && last ? { nextPrimaryId: last.primaryId } : {}),
    }
  }

  async list(params: ListObjectsInput): Promise<{
    objects: readonly ObjectRow[]
    hasMore: boolean
    total: number
  }> {
    return this.listWithScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private listWithScope(
    params: ListObjectsInput,
    scope: CompiledObjectReadScope
  ): { objects: readonly ObjectRow[]; hasMore: boolean; total: number } {
    const source = compileSqliteObjectReadSource(params.projectId, scope)
    let query = `SELECT * FROM ${source.objectsTable} WHERE project_id = ?`
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
    const countStatement = source.scopeStatement(`SELECT COUNT(*) as total FROM (${query})`, args)
    const countResult = this.db.query(countStatement.sql).get(...countStatement.args) as {
      total: number
    }
    const total = countResult.total

    const { limit, offset } = normalizeObjectListWindow(params)
    if (limit === 0) return { objects: [], hasMore: offset < total, total }

    // Add ordering
    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"
    const orderColumn =
      orderBy === "primaryId" ? "primary_id" : orderBy === "createdAt" ? "created_at" : "updated_at"
    query += ` ORDER BY ${orderColumn} ${order.toUpperCase()}`

    // Add pagination
    query += " LIMIT ? OFFSET ?"
    args.push(limit, offset)

    const rowsStatement = source.scopeStatement(query, args)
    const rows = this.db.query(rowsStatement.sql).all(...rowsStatement.args) as DatabaseRow[]
    const objects = rows.map((row) => this.rowToObject(row))
    const hasMore = objectListHasMore({ total, offset, returnedRows: objects.length })

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
    const properties = row.properties
      ? (JSON.parse(row.properties) as Record<string, unknown>)
      : null
    return {
      projectId: row.project_id,
      sourceTypeId: row.source_type_id,
      sourceId: row.source_id,
      linkId: row.link_id,
      targetTypeId: row.target_type_id,
      targetId: row.target_id,
      ...(properties ? { properties } : {}),
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

function fullLinkIdentity(link: ObjectLinkRow): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

/**
 * Keep a scoped reader's budget probe and terminal statements on one SQLite snapshot.
 *
 * Every SQLite object read is synchronous, so a deferred transaction cannot overlap another
 * operation on this connection. An enclosing storage transaction already owns the connection and
 * its snapshot; joining it avoids a nested BEGIN while preserving the same guarantee.
 */
function runReadSnapshot<T>(db: Database, run: () => T): T {
  if (db.inTransaction) return run()
  return db.transaction(run).deferred()
}

function assertTraversalBudget(
  db: Database,
  probe:
    | {
        readonly sql: string
        readonly args: readonly (string | number | bigint | boolean | null)[]
      }
    | undefined,
  limits: ObjectReadExecutionLimits
): void {
  if (!probe) return
  const row = db.query(probe.sql).get(...probe.args) as { total: number | bigint }
  if (BigInt(row.total) > BigInt(limits.maxTraversalFacts)) {
    throw new DelegatedExecutionLimitError("traversalFacts", limits.maxTraversalFacts)
  }
}

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
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

function toLegacyObjectBatchMap(
  items: readonly { readonly objectTypeId: string; readonly primaryId: string }[],
  rows: readonly (ObjectRow | null)[]
): Map<string, ObjectRow> {
  const result = new Map<string, ObjectRow>()
  items.forEach((item, index) => {
    const row = rows[index]
    if (row) result.set(`${item.objectTypeId}:${item.primaryId}`, row)
  })
  return result
}

function toLegacyLinkBatchMap(
  items: readonly {
    readonly objectTypeId: string
    readonly objectId: string
    readonly linkId: string
  }[],
  rows: readonly (readonly ObjectLinkRow[])[]
): Map<string, ObjectLinkRow[]> {
  const result = new Map<string, ObjectLinkRow[]>()
  items.forEach((item, index) => {
    const links = rows[index]
    if (links.length > 0) {
      result.set(`${item.objectTypeId}:${item.objectId}:${item.linkId}`, [...links])
    }
  })
  return result
}
