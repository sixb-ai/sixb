import type {
  CompiledSelectedObjectReadScope,
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkBatchKey,
  LinkDirection,
  ObjectBatchKey,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "../pg-client"
import type { PgStoreClient } from "../transactions"
import { DEFAULT_OBJECT_QUERY_SOURCE } from "./query-compiler"
import { assertLinkQueryLimit, PgObjectReader } from "./reader"
import {
  type LinkDatabaseRow,
  linkIdentity,
  type ObjectDatabaseRow,
  rowToLink,
  rowToObject,
} from "./rows"
import { createPgSelectedReader } from "./selected-reader"

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

/** PostgreSQL object provider; interactive reads share one source-aware reader. */
export class PgObjectStorage implements ObjectStorage {
  private readonly reader: PgObjectReader

  constructor(private readonly sql: PgStoreClient) {
    this.reader = new PgObjectReader(sql, DEFAULT_OBJECT_QUERY_SOURCE)
  }

  queryCapabilities(): ObjectQueryCapabilities {
    return PG_OBJECT_QUERY_CAPABILITIES
  }

  createSelectedReadScope(params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    return createPgSelectedReader(this.sql, params, () => this.queryCapabilities())
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    return this.reader.queryObjects(params)
  }

  async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    return this.reader.countObjects(params)
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return this.reader.existsObjects(params)
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    return this.reader.facetObjects(params)
  }

  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    return this.reader.getByPrimaryId(params)
  }

  async selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): Promise<readonly boolean[]> {
    return this.reader.selectsObjectProperties(params)
  }

  async listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]> {
    return this.reader.listLinks(params)
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<ObjectBatchKey, ObjectRow>> {
    return this.reader.getByPrimaryIdBatch(params)
  }

  async listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    return this.reader.listLinksBatch(params)
  }

  async queryLinks(params: QueryObjectLinksInput): Promise<QueryObjectLinksResult> {
    assertLinkQueryLimit(params.limit)
    return this.reader.queryLinks(params)
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
    return this.reader.list(params)
  }
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

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}
