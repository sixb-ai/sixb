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
  LinkDirection,
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
import type { SQLClient, SqlParameter } from "./pg-client"
import {
  type CompiledPgObjectQuery,
  type CompiledPgScalarQuery,
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
  compilePgObjectReadScopeTraversalProbe,
  compilePgObjectReadSql,
} from "./pg-object-query-compiler"
import { type PgStoreClient, runPgTransaction } from "./transactions"

const PG_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
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
    decimal: { equality: true, ordering: true },
    date: { equality: true, ordering: true },
    timestamp: { equality: true, ordering: true },
  },
  limits: {
    totalCount: true,
    stablePageTokens: true,
  },
  notes: [
    "PostgreSQL object query pushdown supports start/refs/filter/text/sort/limit/page/traverse/set/project/expand over JSONB properties and object links.",
    "expand hydrates linked objects in-database (top-N per parent via LATERAL + jsonb_agg); core resolves each expansion's cardinality before pushdown, and a mixed/unresolved one stays on the fallback.",
    "Exact decimal predicates, ordering, and keyset pagination use PostgreSQL numeric casts.",
    "Relevance sorting, vector search, and unresolved start.includeSubtypes remain planner fallback or rejection cases.",
  ],
}

const ALL_OBJECT_READ_SCOPE: CompiledObjectReadScope = Object.freeze({ kind: "all" })
type ListObjectsStorageInput = Parameters<ObjectReadStorage["list"]>[0]
type GetObjectsManyInput = Parameters<ObjectReadStorage["getByPrimaryIdMany"]>[0]
type SelectsObjectPropertiesInput = Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
type ListLinksManyInput = Parameters<ObjectReadStorage["listLinksMany"]>[0]
type ListLinksBatchInput = Parameters<ObjectStorage["listLinksBatch"]>[0]

/**
 * Join a variable-size batch as a typed PostgreSQL set.
 *
 * One JSONB parameter carries the whole relation. A parameter per cell would make an otherwise
 * valid batch fail at PostgreSQL's 65,535-parameter protocol limit. The columns are internal,
 * fixed SQL identifiers; every caller-provided value remains data inside the JSON document.
 */
function recordsetJoin<Row = unknown>(
  sql: SQLClient,
  projectId: string,
  readScope: CompiledObjectReadScope,
  select: string,
  columns: readonly string[],
  tuples: readonly (readonly string[])[],
  where: string,
  whereParams: readonly unknown[]
): Promise<Row[]> {
  const alias = "t"
  const records = tuples.map((tuple) =>
    Object.fromEntries(columns.map((column, index) => [column, tuple[index]]))
  )

  const onClause = columns
    .map((c) => {
      // Infer the table alias from the SELECT clause (first word after SELECT ... FROM)
      const srcAlias = select.match(/FROM\s+\w+\s+(\w+)/i)?.[1] ?? select.split(" ").pop()
      return `${srcAlias}.${c} = ${alias}.${c}`
    })
    .join(" AND ")

  const compiled = compilePgObjectReadSql(
    projectId,
    readScope,
    `${select} JOIN jsonb_to_recordset(?::text::jsonb) AS ${alias}(${columns
      .map((column) => `${column} text`)
      .join(", ")}) ON ${onClause} ${where}`,
    [JSON.stringify(records), ...whereParams]
  )

  return sql.unsafe(compiled.sql, compiled.args as SqlParameter[]) as unknown as Promise<Row[]>
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

  createReadScope(params: {
    projectId: string
    scope: ObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    const projectId = params.projectId
    const readScope = compileObjectReadScope(params.scope)
    const readLimits = snapshotObjectReadExecutionLimits(params.limits)
    const traversalProbe =
      readScope.kind === "selected"
        ? compilePgObjectReadScopeTraversalProbe(projectId, readScope, readLimits.maxTraversalFacts)
        : undefined
    const assertProject = (actualProjectId: string) =>
      assertObjectReaderProject(projectId, actualProjectId)
    // Root readers own a repeatable snapshot for every probe + terminal sequence. A reader built
    // from `tx.objects` cannot open a nested transaction and intentionally inherits the isolation
    // and snapshot semantics chosen by that transaction's caller; every statement remains scoped.
    const execute = async <T>(operation: (storage: PgObjectStorage) => Promise<T>): Promise<T> =>
      runPgTransaction(
        this.sql,
        async (tx) => {
          const storage = tx === this.sql ? this : new PgObjectStorage(tx)
          try {
            await assertTraversalBudget(tx, traversalProbe, readLimits)
            const value = await operation(storage)
            assertVisibleJsonWithinLimit(value, readLimits)
            return value
          } catch (error) {
            if (readScope.kind === "selected" && isTraversalBudgetSqlError(error)) {
              throw new DelegatedExecutionLimitError("traversalFacts", readLimits.maxTraversalFacts)
            }
            throw error
          }
        },
        { isolation: "repeatable-read" }
      )
    const reader: ObjectReadStorage = {
      queryCapabilities: () => this.queryCapabilities(),
      queryObjects: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.queryObjectsWithinScope(input, readScope, readLimits))
      },
      countObjects: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.countObjectsWithinScope(input, readScope, readLimits))
      },
      existsObjects: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.existsObjectsWithinScope(input, readScope, readLimits))
      },
      facetObjects: async (input) => {
        assertProject(input.projectId)
        assertFacetCount(input.facets.length)
        return execute((storage) => storage.facetObjectsWithinScope(input, readScope, readLimits))
      },
      getByPrimaryId: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.getByPrimaryIdWithinScope(input, readScope, readLimits))
      },
      selectsObjectProperties: async (input) => {
        assertProject(input.projectId)
        return execute((storage) =>
          storage.selectsObjectPropertiesWithinScope(input, readScope, readLimits)
        )
      },
      listLinks: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.listLinksWithinScope(input, readScope, readLimits))
      },
      getByPrimaryIdMany: async (input) => {
        assertProject(input.projectId)
        return execute((storage) =>
          storage.getByPrimaryIdManyWithinScope(input, readScope, readLimits)
        )
      },
      listLinksMany: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.listLinksManyWithinScope(input, readScope, readLimits))
      },
      list: async (input) => {
        assertProject(input.projectId)
        return execute((storage) => storage.listWithinScope(input, readScope, readLimits))
      },
    }
    return Object.freeze(reader)
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    return this.queryObjectsWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async queryObjectsWithinScope(
    params: QueryObjectsInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<QueryObjectsResult> {
    const compiled = compilePgObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      readScope,
      readLimits,
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
    return this.countObjectsWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async countObjectsWithinScope(
    params: CountObjectsInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<CountObjectsResult> {
    const compiled = compilePgObjectCountQuery(
      params.projectId,
      stripOuterRowShape(params.query),
      readScope,
      readLimits
    )
    const [row] = await this.sql.unsafe<{ count: string | number | bigint }[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    return { count: Number(row?.count ?? 0) }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return this.existsObjectsWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async existsObjectsWithinScope(
    params: ExistsObjectsInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<ExistsObjectsResult> {
    const compiled = compilePgObjectExistsQuery(
      params.projectId,
      stripOuterRowShape(params.query),
      readScope,
      readLimits
    )
    const [row] = await this.sql.unsafe<unknown[]>(compiled.sql, compiled.args as SqlParameter[])
    return { exists: row !== undefined }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return this.facetObjectsWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async facetObjectsWithinScope(
    params: FacetObjectsInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<FacetObjectsResult> {
    assertFacetCount(params.facets.length)

    const facets: FacetObjectsResult["facets"][number][] = []
    for (const facet of params.facets) {
      facets.push({
        propertyId: facet.propertyId,
        buckets: await readFacetBuckets(
          this.sql,
          compilePgObjectFacetQuery(
            params.projectId,
            stripOuterRowShape(params.query),
            facet.propertyId,
            facet.limit,
            readScope,
            readLimits
          )
        ),
      })
    }
    return { facets }
  }

  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    return this.getByPrimaryIdWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async getByPrimaryIdWithinScope(
    params: { projectId: string; objectTypeId: string; primaryId: string },
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<ObjectRow | null> {
    const compiled = compilePgObjectReadSql(
      params.projectId,
      readScope,
      `
        SELECT * FROM objects
        WHERE project_id = ?
          AND object_type_id = ?
          AND primary_id = ?
      `,
      [params.projectId, params.objectTypeId, params.primaryId],
      readLimits
    )
    const [row] = await this.sql.unsafe<ObjectDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )

    return row ? rowToObject(row) : null
  }

  async selectsObjectProperties(params: SelectsObjectPropertiesInput): Promise<readonly boolean[]> {
    return this.selectsObjectPropertiesWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async selectsObjectPropertiesWithinScope(
    params: SelectsObjectPropertiesInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<readonly boolean[]> {
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const selected = readScope.kind === "selected"
    const records = params.items.map((item, batchIndex) => ({
      batch_index: batchIndex,
      object_type_id: item.objectTypeId,
      primary_id: item.primaryId,
      property_id: item.propertyId,
    }))
    const compiled = compilePgObjectReadSql(
      params.projectId,
      readScope,
      selected
        ? `
          SELECT DISTINCT requested.batch_index AS _batch_index
          FROM sixb_scope_visible_object_properties AS stored
          JOIN jsonb_to_recordset(?::text::jsonb) AS requested(
            batch_index integer,
            object_type_id text,
            primary_id text,
            property_id text
          )
            ON stored.object_type_id = requested.object_type_id
           AND stored.primary_id = requested.primary_id
           AND stored.property_id = requested.property_id
          WHERE stored.project_id = ?
        `
        : `
          SELECT DISTINCT requested.batch_index AS _batch_index
          FROM objects AS stored
          JOIN jsonb_to_recordset(?::text::jsonb) AS requested(
            batch_index integer,
            object_type_id text,
            primary_id text,
            property_id text
          )
            ON stored.object_type_id = requested.object_type_id
           AND stored.primary_id = requested.primary_id
          WHERE stored.project_id = ?
        `,
      [JSON.stringify(records), params.projectId],
      readLimits
    )
    const rows = await this.sql.unsafe<PropertyPermissionBatchDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    for (const row of rows) {
      result[row._batch_index] = true
    }
    return result
  }

  async listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]> {
    return this.listLinksWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async listLinksWithinScope(
    params: {
      projectId: string
      objectTypeId: string
      objectId: string
      linkId?: string
      direction?: LinkDirection
    },
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<readonly ObjectLinkRow[]> {
    const direction = params.direction ?? "outgoing"
    const directionWhere =
      direction === "incoming"
        ? "target_type_id = ? AND target_id = ?"
        : direction === "both"
          ? "((source_type_id = ? AND source_id = ?) OR (target_type_id = ? AND target_id = ?))"
          : "source_type_id = ? AND source_id = ?"
    const directionArgs =
      direction === "both"
        ? [params.objectTypeId, params.objectId, params.objectTypeId, params.objectId]
        : [params.objectTypeId, params.objectId]
    const compiled = compilePgObjectReadSql(
      params.projectId,
      readScope,
      `SELECT * FROM links WHERE project_id = ? AND ${directionWhere}${
        params.linkId ? " AND link_id = ?" : ""
      }`,
      [params.projectId, ...directionArgs, ...(params.linkId ? [params.linkId] : [])],
      readLimits
    )
    const rows = await this.sql.unsafe<LinkDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )

    return rows.map((row) => rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>> {
    const rows = await this.getByPrimaryIdManyWithinScope(params, ALL_OBJECT_READ_SCOPE)
    return toLegacyObjectBatchMap(params.items, rows)
  }

  async getByPrimaryIdMany(params: GetObjectsManyInput): Promise<readonly (ObjectRow | null)[]> {
    return this.getByPrimaryIdManyWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async getByPrimaryIdManyWithinScope(
    params: GetObjectsManyInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<readonly (ObjectRow | null)[]> {
    const result = params.items.map<ObjectRow | null>(() => null)
    if (params.items.length === 0) return result
    const records = params.items.map((item, batchIndex) => ({
      batch_index: batchIndex,
      object_type_id: item.objectTypeId,
      primary_id: item.primaryId,
    }))
    const compiled = compilePgObjectReadSql(
      params.projectId,
      readScope,
      `SELECT o.*, requested.batch_index AS _batch_index
       FROM objects o
       JOIN jsonb_to_recordset(?::text::jsonb) AS requested(
         batch_index integer,
         object_type_id text,
         primary_id text
       )
         ON o.object_type_id = requested.object_type_id
        AND o.primary_id = requested.primary_id
       WHERE o.project_id = ?`,
      [JSON.stringify(records), params.projectId],
      readLimits
    )
    const rows = await this.sql.unsafe<ObjectBatchDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )

    for (const row of rows) {
      result[row._batch_index] = rowToObject(row)
    }
    return result
  }

  async listLinksBatch(params: ListLinksBatchInput): Promise<Map<string, ObjectLinkRow[]>> {
    const rows = await this.listLinksManyWithinScope(params, ALL_OBJECT_READ_SCOPE)
    return toLegacyLinkBatchMap(params.items, rows)
  }

  async listLinksMany(params: ListLinksManyInput): Promise<readonly (readonly ObjectLinkRow[])[]> {
    return this.listLinksManyWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async listLinksManyWithinScope(
    params: ListLinksManyInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<readonly (readonly ObjectLinkRow[])[]> {
    const result = params.items.map(() => new Map<string, ObjectLinkRow>())
    if (params.items.length === 0) return []
    const direction = params.direction ?? "outgoing"
    const records = params.items.map((item, batchIndex) => ({
      batch_index: batchIndex,
      object_type_id: item.objectTypeId,
      object_id: item.objectId,
      link_id: item.linkId,
    }))
    const append = (row: LinkBatchDatabaseRow): void => {
      const link = rowToLink(row)
      result[row._batch_index].set(fullLinkIdentity(link), link)
    }
    const readSide = async (side: "source" | "target"): Promise<void> => {
      const typeColumn = side === "source" ? "source_type_id" : "target_type_id"
      const idColumn = side === "source" ? "source_id" : "target_id"
      const compiled = compilePgObjectReadSql(
        params.projectId,
        readScope,
        `SELECT l.*, requested.batch_index AS _batch_index
         FROM links l
         JOIN jsonb_to_recordset(?::text::jsonb) AS requested(
           batch_index integer,
           object_type_id text,
           object_id text,
           link_id text
         )
           ON l.${typeColumn} = requested.object_type_id
          AND l.${idColumn} = requested.object_id
          AND l.link_id = requested.link_id
         WHERE l.project_id = ?`,
        [JSON.stringify(records), params.projectId],
        readLimits
      )
      const rows = await this.sql.unsafe<LinkBatchDatabaseRow[]>(
        compiled.sql,
        compiled.args as SqlParameter[]
      )
      for (const row of rows) append(row)
    }

    if (direction === "outgoing" || direction === "both") {
      await readSide("source")
    }

    if (direction === "incoming" || direction === "both") {
      await readSide("target")
    }

    return result.map((links) => [...links.values()])
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
    const sourceRows = await recordsetJoin<LinkDatabaseRow>(
      this.sql,
      params.projectId,
      ALL_OBJECT_READ_SCOPE,
      "SELECT l.* FROM links l",
      ["source_type_id", "source_id"],
      tuples,
      "WHERE l.project_id = ?",
      [params.projectId]
    )
    const targetRows = await recordsetJoin<LinkDatabaseRow>(
      this.sql,
      params.projectId,
      ALL_OBJECT_READ_SCOPE,
      "SELECT l.* FROM links l",
      ["target_type_id", "target_id"],
      tuples,
      "WHERE l.project_id = ?",
      [params.projectId]
    )

    const deduped = new Map<string, ObjectLinkRow>()
    for (const row of [...sourceRows, ...targetRows]) {
      const link = rowToLink(row)
      deduped.set(fullLinkIdentity(link), link)
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
    const rows = await this.sql<ObjectDatabaseRow[]>`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        ${params.afterPrimaryId ? this.sql`AND primary_id > ${params.afterPrimaryId}` : this.sql``}
      ORDER BY primary_id ASC
      LIMIT ${objectListLookaheadLimit(params.limit)}
    `
    const hasMore = rows.length > params.limit
    const objects = rows.slice(0, params.limit).map((row) => rowToObject(row))
    const last = objects.at(-1)
    return {
      objects,
      ...(hasMore && last ? { nextPrimaryId: last.primaryId } : {}),
    }
  }

  async list(
    params: ListObjectsStorageInput
  ): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    return this.listWithinScope(params, ALL_OBJECT_READ_SCOPE)
  }

  private async listWithinScope(
    params: ListObjectsStorageInput,
    readScope: CompiledObjectReadScope,
    readLimits?: ObjectReadExecutionLimits
  ): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    const { limit, offset: queryOffset } = normalizeObjectListWindow(params)
    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"
    const orderColumn =
      orderBy === "primaryId" ? "primary_id" : orderBy === "createdAt" ? "created_at" : "updated_at"

    const predicates = ["project_id = ?"]
    const filterArgs: unknown[] = [params.projectId]
    if (typeof params.objectTypeId === "string") {
      predicates.push("object_type_id = ?")
      filterArgs.push(params.objectTypeId)
    } else if (params.objectTypeId) {
      if (params.objectTypeId.length === 0) {
        predicates.push("FALSE")
      } else {
        predicates.push(`object_type_id IN (${params.objectTypeId.map(() => "?").join(", ")})`)
        filterArgs.push(...params.objectTypeId)
      }
    }
    if (params.primaryIdPrefix) {
      predicates.push("primary_id LIKE ?")
      filterArgs.push(`${params.primaryIdPrefix}%`)
    }
    if (params.primaryIdSuffix) {
      predicates.push("primary_id LIKE ?")
      filterArgs.push(`%${params.primaryIdSuffix}`)
    }
    if (params.updatedAfter) {
      predicates.push("updated_at >= ?")
      filterArgs.push(params.updatedAfter)
    }
    if (params.updatedBefore) {
      predicates.push("updated_at <= ?")
      filterArgs.push(params.updatedBefore)
    }
    if (params.createdAfter) {
      predicates.push("created_at >= ?")
      filterArgs.push(params.createdAfter)
    }
    if (params.createdBefore) {
      predicates.push("created_at <= ?")
      filterArgs.push(params.createdBefore)
    }
    const where = predicates.join(" AND ")
    const countQuery = compilePgObjectReadSql(
      params.projectId,
      readScope,
      `SELECT COUNT(*)::int AS total FROM objects WHERE ${where}`,
      filterArgs,
      readLimits
    )
    const [countResult] = await this.sql.unsafe<{ total: number }[]>(
      countQuery.sql,
      countQuery.args as SqlParameter[]
    )
    const total = countResult?.total ?? 0

    if (limit === 0) return { objects: [], hasMore: queryOffset < total, total }

    // Both identifiers come from closed mappings above, never caller-provided SQL.
    const pageQuery = compilePgObjectReadSql(
      params.projectId,
      readScope,
      `
        SELECT * FROM objects
        WHERE ${where}
        ORDER BY ${orderColumn} ${order === "asc" ? "ASC" : "DESC"}
        LIMIT ? OFFSET ?
      `,
      [...filterArgs, limit, queryOffset],
      readLimits
    )
    const rows = await this.sql.unsafe<ObjectDatabaseRow[]>(
      pageQuery.sql,
      pageQuery.args as SqlParameter[]
    )

    const objects = rows.map((row) => rowToObject(row))
    const hasMore = objectListHasMore({
      total,
      offset: queryOffset,
      returnedRows: objects.length,
    })

    return { objects, hasMore, total }
  }
}

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}

function assertFacetCount(count: number): void {
  if (count > MAX_OBJECT_FACETS_PER_READ) {
    throw new Error(`[SixbPg] A facet read supports at most ${MAX_OBJECT_FACETS_PER_READ} facets.`)
  }
}

function isTraversalBudgetSqlError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22012"
}

async function assertTraversalBudget(
  sql: SQLClient,
  probe: CompiledPgScalarQuery | undefined,
  limits: ObjectReadExecutionLimits
): Promise<void> {
  if (!probe) return
  const [row] = await sql.unsafe<{ total: string | number | bigint }[]>(probe.sql, [
    ...probe.args,
  ] as SqlParameter[])
  if (BigInt(row?.total ?? 0) > BigInt(limits.maxTraversalFacts)) {
    throw new DelegatedExecutionLimitError("traversalFacts", limits.maxTraversalFacts)
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
    lastCommitId: row.last_commit_id,
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
    lastCommitId: String(row.lastCommitId),
  }
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
  const properties = row.properties as Record<string, unknown> | null
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

function fullLinkIdentity(link: ObjectLinkRow): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

interface ObjectDatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: unknown
  created_at: Date | string
  updated_at: Date | string
  version: number
  last_commit_id: string
}

interface ObjectQueryDatabaseRow extends ObjectDatabaseRow {
  _cursor_properties?: unknown
  /** `jsonb_build_object(linkId, value, ...)` from an `expand` pushdown; absent otherwise. */
  _expand?: unknown
}

interface ObjectBatchDatabaseRow extends ObjectDatabaseRow {
  _batch_index: number
}

interface PropertyPermissionBatchDatabaseRow {
  _batch_index: number
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
