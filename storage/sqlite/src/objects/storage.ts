import type { Database } from "bun:sqlite"
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
  ObjectReadScopeFactory,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "../migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "../transactions"
import { DEFAULT_OBJECT_QUERY_SOURCE } from "./query-compiler"
import { assertLinkQueryLimit, SqliteObjectReader } from "./reader"
import { type DatabaseRow, type LinkDatabaseRow, rowToLink, rowToObject } from "./rows"
import { createSqliteSelectedReader } from "./selected-reader"

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
export class SqliteObjectStorage implements ObjectStorage, ObjectReadScopeFactory {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database
  private readonly reader: SqliteObjectReader

  constructor(options: SqliteObjectStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    this.reader = new SqliteObjectReader(this.db, DEFAULT_OBJECT_QUERY_SOURCE)

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
    return createSqliteSelectedReader(this.db, params, () => this.queryCapabilities())
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

    return rows.map((row) => rowToLink(row))
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

  /** Close the connection only when this provider owns it. */
  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}
