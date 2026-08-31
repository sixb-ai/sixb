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
  LinkBatchKey,
  LinkDirection,
  ObjectBatchKey,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectRow,
  ObjectRowLinks,
  ObjectStorage,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import { linkBatchKey, objectBatchKey } from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "./pg-client"
import {
  type CompiledPgObjectQuery,
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
} from "./pg-object-query-compiler"
import type { PgStoreClient } from "./transactions"

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

  async selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): Promise<readonly boolean[]> {
    const objects = await this.getByPrimaryIdBatch({
      projectId: params.projectId,
      items: params.items,
    })
    return params.items.map((item) =>
      objects.has(objectBatchKey(item.objectTypeId, item.primaryId))
    )
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
  }): Promise<Map<ObjectBatchKey, ObjectRow>> {
    const result = new Map<ObjectBatchKey, ObjectRow>()
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
      result.set(objectBatchKey(row.object_type_id, row.primary_id), rowToObject(row))
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    const result = new Map<LinkBatchKey, Map<string, ObjectLinkRow>>()
    if (params.items.length === 0) return new Map()

    const readSide = async (side: "source" | "target"): Promise<void> => {
      const rows = await valuesJoin<LinkDatabaseRow>(
        this.sql,
        "SELECT l.* FROM links l",
        [`${side}_type_id`, `${side}_id`, "link_id"],
        params.items.map((item) => [item.objectTypeId, item.objectId, item.linkId]),
        `WHERE l.project_id = $1`,
        [params.projectId]
      )
      for (const row of rows) {
        const link = rowToLink(row)
        const objectTypeId = side === "source" ? row.source_type_id : row.target_type_id
        const objectId = side === "source" ? row.source_id : row.target_id
        const key = linkBatchKey(objectTypeId, objectId, row.link_id)
        const bucket = result.get(key) ?? new Map<string, ObjectLinkRow>()
        bucket.set(linkIdentity(link), link)
        result.set(key, bucket)
      }
    }

    const direction = params.direction ?? "outgoing"
    if (direction === "outgoing" || direction === "both") await readSide("source")
    if (direction === "incoming" || direction === "both") await readSide("target")

    return new Map([...result].map(([key, links]) => [key, [...links.values()]] as const))
  }

  async queryLinks(params: QueryObjectLinksInput): Promise<QueryObjectLinksResult> {
    assertLinkQueryLimit(params.limit)
    if (params.objectRefs.length === 0 || params.endpointObjectTypeIds?.length === 0) {
      return { links: [], hasMore: false }
    }

    const args: SqlParameter[] = [JSON.stringify(params.objectRefs), params.projectId]
    const addArg = (value: SqlParameter): string => {
      args.push(value)
      return `$${args.length}`
    }
    const sourceJoin = `
      SELECT link.*
      FROM links AS link
      JOIN requested
        ON requested.object_type_id = link.source_type_id
       AND requested.object_id = link.source_id
      WHERE link.project_id = $2
    `
    const targetJoin = `
      SELECT link.*
      FROM links AS link
      JOIN requested
        ON requested.object_type_id = link.target_type_id
       AND requested.object_id = link.target_id
      WHERE link.project_id = $2
    `
    const incidentSql =
      params.direction === "outgoing"
        ? sourceJoin
        : params.direction === "incoming"
          ? targetJoin
          : `${sourceJoin} UNION ${targetJoin}`

    const predicates: string[] = []
    if (params.linkId !== undefined) {
      predicates.push(`link_id = ${addArg(params.linkId)}::text`)
    }
    if (params.endpointObjectTypeIds !== undefined) {
      const allowedTypes = addArg(JSON.stringify([...new Set(params.endpointObjectTypeIds)]))
      predicates.push(
        `source_type_id IN (SELECT jsonb_array_elements_text(${allowedTypes}::text::jsonb))`,
        `target_type_id IN (SELECT jsonb_array_elements_text(${allowedTypes}::text::jsonb))`
      )
    }
    if (params.after) {
      const cursor = params.after.map((value) => `${addArg(value)}::text`)
      predicates.push(
        `(source_type_id, source_id, link_id, target_type_id, target_id) > (${cursor.join(", ")})`
      )
    }
    const limit = addArg(params.limit + 1)
    const whereSql = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""
    const rows = await this.sql.unsafe<LinkDatabaseRow[]>(
      `
        WITH requested AS (
          SELECT DISTINCT
            requested."objectTypeId" AS object_type_id,
            requested."primaryId" AS object_id
          FROM jsonb_to_recordset($1::text::jsonb)
            AS requested("objectTypeId" text, "primaryId" text)
        ), incident AS (${incidentSql})
        SELECT *
        FROM incident
        ${whereSql}
        ORDER BY source_type_id, source_id, link_id, target_type_id, target_id
        LIMIT ${limit}
      `,
      args
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
    properties: row.properties ? (row.properties as Record<string, unknown>) : undefined,
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
