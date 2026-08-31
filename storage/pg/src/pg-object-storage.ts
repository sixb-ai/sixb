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
  ObjectFacetResult,
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
import type { SQLClient, SqlParameter } from "./pg-client"
import {
  type CompiledPgObjectQuery,
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
  compilePgObjectStatement,
  type PgObjectQuerySource,
} from "./pg-object-query-compiler"
import {
  compilePgSelectedObjectReadSource,
  type PgSelectedObjectReadSource,
} from "./pg-object-read-scope"
import { type PgStoreClient, runPgRepeatableReadTransaction } from "./transactions"

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

  createSelectedReadScope(params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    const projectId = params.projectId
    const limits = snapshotObjectReadExecutionLimits(params.limits)
    const source = compilePgSelectedObjectReadSource(
      projectId,
      params.scope,
      limits.maxTraversalFacts
    )
    const assertProject = (actualProjectId: string): void =>
      assertObjectReaderProject(projectId, actualProjectId)
    const read = <T>(run: (sql: SQLClient) => Promise<T>): Promise<T> =>
      runPgRepeatableReadTransaction(this.sql, async (sql) => {
        await assertTraversalBudget(sql, source, limits.maxTraversalFacts)
        const value = await run(sql)
        assertObjectReadOutputWithinLimit(value, limits)
        return value
      })
    const readMap = <TKey, TValue>(
      run: (sql: SQLClient) => Promise<Map<TKey, TValue>>
    ): Promise<Map<TKey, TValue>> =>
      runPgRepeatableReadTransaction(this.sql, async (sql) => {
        await assertTraversalBudget(sql, source, limits.maxTraversalFacts)
        const value = await run(sql)
        assertObjectReadOutputWithinLimit([...value.entries()], limits)
        return value
      })

    return Object.freeze({
      queryCapabilities: () => this.queryCapabilities(),
      queryObjects: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.queryObjectsFromSource(sql, input, source))
      },
      countObjects: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.countObjectsFromSource(sql, input, source))
      },
      existsObjects: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.existsObjectsFromSource(sql, input, source))
      },
      facetObjects: async (input) => {
        assertProject(input.projectId)
        assertObjectReadFacetCount(input.facets.length)
        return read((sql) => this.facetObjectsFromSource(sql, input, source))
      },
      getByPrimaryId: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.getByPrimaryIdFromSource(sql, input, source))
      },
      selectsObjectProperties: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.selectsObjectPropertiesFromSource(sql, input, source))
      },
      listLinks: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.listLinksFromSource(sql, input, source))
      },
      getByPrimaryIdBatch: async (input) => {
        assertProject(input.projectId)
        return readMap((sql) => this.getByPrimaryIdBatchFromSource(sql, input, source))
      },
      listLinksBatch: async (input) => {
        assertProject(input.projectId)
        return readMap((sql) => this.listLinksBatchFromSource(sql, input, source))
      },
      queryLinks: async (input) => {
        assertProject(input.projectId)
        assertLinkQueryLimit(input.limit)
        return read((sql) => this.queryLinksFromSource(sql, input, source))
      },
      list: async (input) => {
        assertProject(input.projectId)
        return read((sql) => this.listFromSource(sql, input, source))
      },
    } satisfies ObjectReadStorage)
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    return this.queryObjectsFromSource(this.sql, params)
  }

  private async queryObjectsFromSource(
    sql: SQLClient,
    params: QueryObjectsInput,
    source?: PgObjectQuerySource
  ): Promise<QueryObjectsResult> {
    const compiled = compilePgObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      ...(source ? { source } : {}),
    })
    const total = params.includeTotal === false ? undefined : await readTotal(sql, compiled)
    const rawRows = await sql.unsafe<ObjectQueryDatabaseRow[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    const rows = compiled.trimRows(rawRows) as readonly ObjectQueryDatabaseRow[]
    const hasMore =
      total === undefined && compiled.hasMoreProbe
        ? compiled.hasMoreProbe.hasMore(
            (
              await sql.unsafe(
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
    return this.countObjectsFromSource(this.sql, params)
  }

  private async countObjectsFromSource(
    sql: SQLClient,
    params: CountObjectsInput,
    source?: PgObjectQuerySource
  ): Promise<CountObjectsResult> {
    const compiled = compilePgObjectCountQuery(params.projectId, stripOuterRowShape(params.query), {
      ...(source ? { source } : {}),
    })
    const [row] = await sql.unsafe<{ count: string | number | bigint }[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    return { count: Number(row?.count ?? 0) }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return this.existsObjectsFromSource(this.sql, params)
  }

  private async existsObjectsFromSource(
    sql: SQLClient,
    params: ExistsObjectsInput,
    source?: PgObjectQuerySource
  ): Promise<ExistsObjectsResult> {
    const compiled = compilePgObjectExistsQuery(
      params.projectId,
      stripOuterRowShape(params.query),
      { ...(source ? { source } : {}) }
    )
    const [row] = await sql.unsafe<unknown[]>(compiled.sql, compiled.args as SqlParameter[])
    return { exists: row !== undefined }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return this.facetObjectsFromSource(this.sql, params)
  }

  private async facetObjectsFromSource(
    sql: SQLClient,
    params: FacetObjectsInput,
    source?: PgObjectQuerySource
  ): Promise<FacetObjectsResult> {
    const facets: ObjectFacetResult[] = []
    for (const facet of params.facets) {
      facets.push({
        propertyId: facet.propertyId,
        buckets: await readFacetBuckets(
          sql,
          compilePgObjectFacetQuery(
            params.projectId,
            stripOuterRowShape(params.query),
            facet.propertyId,
            facet.limit,
            { ...(source ? { source } : {}) }
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
    return this.getByPrimaryIdFromSource(this.sql, params)
  }

  private async getByPrimaryIdFromSource(
    sql: SQLClient,
    params: {
      projectId: string
      objectTypeId: string
      primaryId: string
    },
    source?: PgObjectQuerySource
  ): Promise<ObjectRow | null> {
    const statement = compilePgObjectStatement(
      `
        SELECT *
        FROM ${source?.objectsTable ?? "objects"}
        WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
      `,
      [params.projectId, params.objectTypeId, params.primaryId],
      source
    )
    const [row] = await sql.unsafe<ObjectDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )

    return row ? rowToObject(row) : null
  }

  async selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): Promise<readonly boolean[]> {
    return this.selectsObjectPropertiesFromSource(this.sql, params)
  }

  private async selectsObjectPropertiesFromSource(
    sql: SQLClient,
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0],
    source?: PgSelectedObjectReadSource
  ): Promise<readonly boolean[]> {
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const storedTable = source?.objectPropertyPermissionsTable ?? "objects"
    const propertyJoin = source ? 'AND stored.property_id = requested."propertyId"' : ""
    const statement = compilePgObjectStatement(
      `
        SELECT DISTINCT requested."batchIndex" AS _batch_index
        FROM ${storedTable} AS stored
        JOIN jsonb_to_recordset(?::text::jsonb)
          AS requested(
            "objectTypeId" text,
            "primaryId" text,
            "propertyId" text,
            "batchIndex" integer
          )
          ON stored.object_type_id = requested."objectTypeId"
         AND stored.primary_id = requested."primaryId"
         ${propertyJoin}
        WHERE stored.project_id = ?
      `,
      [JSON.stringify(items), params.projectId],
      source
    )
    const rows = await sql.unsafe<PropertyPermissionBatchDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )
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
    return this.listLinksFromSource(this.sql, params)
  }

  private async listLinksFromSource(
    sql: SQLClient,
    params: {
      projectId: string
      objectTypeId: string
      objectId: string
      linkId?: string
      direction?: LinkDirection
    },
    source?: PgObjectQuerySource
  ): Promise<readonly ObjectLinkRow[]> {
    const direction = params.direction ?? "outgoing"
    const directionWhere =
      direction === "incoming"
        ? "target_type_id = ? AND target_id = ?"
        : direction === "both"
          ? "((source_type_id = ? AND source_id = ?) OR (target_type_id = ? AND target_id = ?))"
          : "source_type_id = ? AND source_id = ?"
    const args: unknown[] =
      direction === "both"
        ? [
            params.projectId,
            params.objectTypeId,
            params.objectId,
            params.objectTypeId,
            params.objectId,
          ]
        : [params.projectId, params.objectTypeId, params.objectId]
    const query = `SELECT * FROM ${source?.linksTable ?? "links"} WHERE project_id = ? AND ${directionWhere}${
      params.linkId ? " AND link_id = ?" : ""
    }`
    if (params.linkId) args.push(params.linkId)
    const statement = compilePgObjectStatement(query, args, source)
    const rows = await sql.unsafe<LinkDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )

    return rows.map((row) => rowToLink(row))
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<ObjectBatchKey, ObjectRow>> {
    return this.getByPrimaryIdBatchFromSource(this.sql, params)
  }

  private async getByPrimaryIdBatchFromSource(
    sql: SQLClient,
    params: {
      projectId: string
      items: readonly { objectTypeId: string; primaryId: string }[]
    },
    source?: PgObjectQuerySource
  ): Promise<Map<ObjectBatchKey, ObjectRow>> {
    const result = new Map<ObjectBatchKey, ObjectRow>()
    if (params.items.length === 0) return result
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = compilePgObjectStatement(
      `
        SELECT object.*, requested."batchIndex" AS _batch_index
        FROM jsonb_to_recordset(?::text::jsonb)
          AS requested("objectTypeId" text, "primaryId" text, "batchIndex" integer)
        JOIN ${source?.objectsTable ?? "objects"} AS object
          ON object.project_id = ?
         AND object.object_type_id = requested."objectTypeId"
         AND object.primary_id = requested."primaryId"
      `,
      [JSON.stringify(items), params.projectId],
      source
    )
    const rows = await sql.unsafe<ObjectBatchDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )
    const rowsByIndex = new Map(rows.map((row) => [row._batch_index, row]))
    for (const [index, item] of params.items.entries()) {
      const row = rowsByIndex.get(index)
      if (row) result.set(objectBatchKey(item.objectTypeId, item.primaryId), rowToObject(row))
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    return this.listLinksBatchFromSource(this.sql, params)
  }

  private async listLinksBatchFromSource(
    sql: SQLClient,
    params: {
      projectId: string
      direction?: LinkDirection
      items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
    },
    source?: PgObjectQuerySource
  ): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    const result = new Map<LinkBatchKey, ObjectLinkRow[]>()
    if (params.items.length === 0) return result

    const direction = params.direction ?? "outgoing"
    const outgoing =
      'stored.source_type_id = requested."objectTypeId" AND stored.source_id = requested."objectId"'
    const incoming =
      'stored.target_type_id = requested."objectTypeId" AND stored.target_id = requested."objectId"'
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const requestedSql = `
      jsonb_to_recordset(?::text::jsonb)
        AS requested(
          "objectTypeId" text,
          "objectId" text,
          "linkId" text,
          "batchIndex" integer
        )
    `
    const table = source?.linksTable ?? "links"
    const selectedSql =
      direction === "both"
        ? `
          SELECT stored.*, requested."batchIndex" AS _batch_index
          FROM ${requestedSql}
          CROSS JOIN LATERAL (
            SELECT outgoing_link.*
            FROM ${table} AS outgoing_link
            WHERE outgoing_link.project_id = ?
              AND outgoing_link.source_type_id = requested."objectTypeId"
              AND outgoing_link.source_id = requested."objectId"
              AND outgoing_link.link_id = requested."linkId"

            UNION

            SELECT incoming_link.*
            FROM ${table} AS incoming_link
            WHERE incoming_link.project_id = ?
              AND incoming_link.target_type_id = requested."objectTypeId"
              AND incoming_link.target_id = requested."objectId"
              AND incoming_link.link_id = requested."linkId"
          ) AS stored
        `
        : `
          SELECT stored.*, requested."batchIndex" AS _batch_index
          FROM ${requestedSql}
          JOIN ${table} AS stored
            ON ${direction === "incoming" ? incoming : outgoing}
           AND stored.link_id = requested."linkId"
          WHERE stored.project_id = ?
        `
    const statement = compilePgObjectStatement(
      `
        ${selectedSql}
        ORDER BY
          _batch_index,
          source_type_id COLLATE "C",
          source_id COLLATE "C",
          link_id COLLATE "C",
          target_type_id COLLATE "C",
          target_id COLLATE "C"
      `,
      direction === "both"
        ? [JSON.stringify(items), params.projectId, params.projectId]
        : [JSON.stringify(items), params.projectId],
      source
    )
    const rows = await sql.unsafe<LinkBatchDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )
    const rowsByIndex = params.items.map(() => new Map<string, ObjectLinkRow>())
    for (const row of rows) {
      const link = rowToLink(row)
      rowsByIndex[row._batch_index]?.set(linkIdentity(link), link)
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
    return this.queryLinksFromSource(this.sql, params)
  }

  private async queryLinksFromSource(
    sql: SQLClient,
    params: QueryObjectLinksInput,
    source?: PgObjectQuerySource
  ): Promise<QueryObjectLinksResult> {
    if (params.objectRefs.length === 0 || params.endpointObjectTypeIds?.length === 0) {
      return { links: [], hasMore: false }
    }

    const requestedJson = JSON.stringify(params.objectRefs)
    const args: unknown[] =
      params.direction === "both"
        ? [requestedJson, params.projectId, params.projectId]
        : [requestedJson, params.projectId]
    const addArg = (value: unknown): string => {
      args.push(value)
      return "?"
    }
    const requestedSql = `
      jsonb_to_recordset(?::text::jsonb)
        AS requested("objectTypeId" text, "primaryId" text)
    `
    const table = source?.linksTable ?? "links"
    const incidentSql =
      params.direction === "both"
        ? `
          SELECT DISTINCT link.*
          FROM ${requestedSql}
          CROSS JOIN LATERAL (
            SELECT outgoing_link.*
            FROM ${table} AS outgoing_link
            WHERE outgoing_link.project_id = ?
              AND outgoing_link.source_type_id = requested."objectTypeId"
              AND outgoing_link.source_id = requested."primaryId"

            UNION

            SELECT incoming_link.*
            FROM ${table} AS incoming_link
            WHERE incoming_link.project_id = ?
              AND incoming_link.target_type_id = requested."objectTypeId"
              AND incoming_link.target_id = requested."primaryId"
          ) AS link
        `
        : `
          SELECT DISTINCT link.*
          FROM ${requestedSql}
          JOIN ${table} AS link
            ON requested."objectTypeId" = link.${params.direction === "incoming" ? "target_type_id" : "source_type_id"}
           AND requested."primaryId" = link.${params.direction === "incoming" ? "target_id" : "source_id"}
          WHERE link.project_id = ?
        `

    const predicates: string[] = []
    if (params.linkId !== undefined) {
      predicates.push(`link_id = ${addArg(params.linkId)}::text`)
    }
    if (params.endpointObjectTypeIds !== undefined) {
      const allowedTypes = JSON.stringify([...new Set(params.endpointObjectTypeIds)])
      predicates.push(
        `source_type_id IN (SELECT jsonb_array_elements_text(${addArg(allowedTypes)}::text::jsonb))`,
        `target_type_id IN (SELECT jsonb_array_elements_text(${addArg(allowedTypes)}::text::jsonb))`
      )
    }
    if (params.after) {
      const cursor = params.after.map((value) => `${addArg(value)}::text COLLATE "C"`)
      predicates.push(
        `(
          source_type_id COLLATE "C",
          source_id COLLATE "C",
          link_id COLLATE "C",
          target_type_id COLLATE "C",
          target_id COLLATE "C"
        ) > (${cursor.join(", ")})`
      )
    }
    const limit = addArg(params.limit + 1)
    const whereSql = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""
    const statement = compilePgObjectStatement(
      `
        SELECT *
        FROM (${incidentSql}) AS incident
        ${whereSql}
        ORDER BY
          source_type_id COLLATE "C",
          source_id COLLATE "C",
          link_id COLLATE "C",
          target_type_id COLLATE "C",
          target_id COLLATE "C"
        LIMIT ${limit}
      `,
      args,
      source
    )
    const rows = await sql.unsafe<LinkDatabaseRow[]>(
      statement.sql,
      statement.args as SqlParameter[]
    )

    return {
      links: rows.slice(0, params.limit).map((row) => rowToLink(row)),
      hasMore: rows.length > params.limit,
    }
  }

  async listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]> {
    if (params.items.length === 0) return []
    const tuples = params.items.map((item) => [item.objectTypeId, item.objectId])

    // Cover both link directions with two index-friendly equality joins (source-side, then
    // target-side) rather than a single OR-join, which would defeat index usage. This is a constant
    // number of round trips regardless of the requested object count. They are issued sequentially
    // because callers may run on a serializable transaction's single connection. A link incident to
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
    const rows = await this.sql<ObjectDatabaseRow[]>`
      SELECT * FROM objects
      WHERE project_id = ${params.projectId}
        AND object_type_id = ${params.objectTypeId}
        ${params.afterPrimaryId ? this.sql`AND primary_id > ${params.afterPrimaryId}` : this.sql``}
      ORDER BY primary_id ASC
      LIMIT ${params.limit + 1}
    `
    const hasMore = rows.length > params.limit
    const objects = rows.slice(0, params.limit).map((row) => rowToObject(row))
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
    return this.listFromSource(this.sql, params)
  }

  private async listFromSource(
    sql: SQLClient,
    params: Parameters<ObjectReadStorage["list"]>[0],
    source?: PgObjectQuerySource
  ): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    const queryOffset = params.offset ?? 0
    const limit = params.limit ?? 50
    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"
    const orderColumn =
      orderBy === "primaryId" ? "primary_id" : orderBy === "createdAt" ? "created_at" : "updated_at"
    const filters = ["project_id = ?"]
    const args: unknown[] = [params.projectId]
    if (typeof params.objectTypeId === "string") {
      filters.push("object_type_id = ?")
      args.push(params.objectTypeId)
    } else if (params.objectTypeId !== undefined) {
      filters.push("object_type_id IN (SELECT jsonb_array_elements_text(?::text::jsonb))")
      args.push(JSON.stringify(params.objectTypeId))
    }
    if (params.primaryIdPrefix) {
      filters.push("primary_id LIKE ?")
      args.push(`${params.primaryIdPrefix}%`)
    }
    if (params.primaryIdSuffix) {
      filters.push("primary_id LIKE ?")
      args.push(`%${params.primaryIdSuffix}`)
    }
    if (params.updatedAfter) {
      filters.push("updated_at >= ?")
      args.push(params.updatedAfter)
    }
    if (params.updatedBefore) {
      filters.push("updated_at <= ?")
      args.push(params.updatedBefore)
    }
    if (params.createdAfter) {
      filters.push("created_at >= ?")
      args.push(params.createdAfter)
    }
    if (params.createdBefore) {
      filters.push("created_at <= ?")
      args.push(params.createdBefore)
    }

    const objectsTable = source?.objectsTable ?? "objects"
    const whereSql = filters.join(" AND ")
    const countStatement = compilePgObjectStatement(
      `SELECT COUNT(*)::int AS total FROM ${objectsTable} WHERE ${whereSql}`,
      args,
      source
    )
    const [countResult] = await sql.unsafe<{ total: number }[]>(
      countStatement.sql,
      countStatement.args as SqlParameter[]
    )
    const total = countResult?.total ?? 0

    if (limit === 0) return { objects: [], hasMore: queryOffset < total, total }

    const fetchLimit = limit + 1
    const rowsStatement = compilePgObjectStatement(
      `
        SELECT * FROM ${objectsTable}
        WHERE ${whereSql}
        ORDER BY ${orderColumn} ${order === "asc" ? "ASC" : "DESC"}
        LIMIT ? OFFSET ?
      `,
      [...args, fetchLimit, queryOffset],
      source
    )
    const rows = await sql.unsafe<ObjectDatabaseRow[]>(
      rowsStatement.sql,
      rowsStatement.args as SqlParameter[]
    )

    const hasMore = rows.length > limit
    const objects = rows.slice(0, limit).map((row) => rowToObject(row))

    return { objects, hasMore, total }
  }
}

async function assertTraversalBudget(
  sql: SQLClient,
  source: PgSelectedObjectReadSource,
  maxTraversalFacts: number
): Promise<void> {
  const [row] = await sql.unsafe<{ total: string | number | bigint }[]>(
    source.traversalProbe.sql,
    source.traversalProbe.args as SqlParameter[]
  )
  if (BigInt(row?.total ?? 0) > BigInt(maxTraversalFacts)) {
    throw new ObjectReadLimitExceededError("traversalFacts", maxTraversalFacts)
  }
}

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
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
  return {
    projectId: row.project_id,
    sourceTypeId: row.source_type_id,
    sourceId: row.source_id,
    linkId: row.link_id,
    targetTypeId: row.target_type_id,
    targetId: row.target_id,
    ...(row.properties === null ? {} : { properties: row.properties as Record<string, unknown> }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastCommitId: row.last_commit_id,
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

function assertLinkQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object link query limit must be a positive safe integer.")
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
