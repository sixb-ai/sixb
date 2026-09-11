import type { Database } from "bun:sqlite"
import type { ObjectQuery } from "@sixb/core"
import type {
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkBatchKey,
  LinkDirection,
  ObjectBatchKey,
  ObjectFacetRequest,
  ObjectLinkRow,
  ObjectReadStorage,
  ObjectRow,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import { linkBatchKey, objectBatchKey } from "@sixb/core/storage"
import {
  type CompiledObjectQuery,
  compileObjectQuery,
  type SqliteObjectQuerySource,
} from "./query-compiler"
import type { SqliteSelectedObjectReadSource } from "./read-scope"
import {
  type DatabaseRow,
  type LinkDatabaseRow,
  type ObjectQueryDatabaseRow,
  queryRowToObject,
  rowToLink,
  rowToObject,
} from "./rows"

/** Synchronous SQL reads over one explicit source; transaction and budget ownership stay outside. */
export class SqliteObjectReader {
  constructor(
    private readonly db: Database,
    private readonly source: SqliteObjectQuerySource | SqliteSelectedObjectReadSource
  ) {}

  queryObjects(params: QueryObjectsInput): QueryObjectsResult {
    const source = this.source
    const compiled = compileObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      source,
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
      objects: rows.map((row) => queryRowToObject(row)),
      hasMore,
      nextPageToken: compiled.nextPageToken(rows, rawRows.length),
      ...(total === undefined ? {} : { total }),
    }
  }

  countObjects(params: CountObjectsInput): CountObjectsResult {
    const source = this.source
    return {
      count: readTotal(
        this.db,
        compileObjectQuery(params.projectId, stripOuterRowShape(params.query), {
          source,
        })
      ),
    }
  }

  existsObjects(params: ExistsObjectsInput): ExistsObjectsResult {
    const source = this.source
    const compiled = compileObjectQuery(params.projectId, existsProbeQuery(params.query), {
      source,
    })
    return { exists: this.db.query(compiled.sql).get(...compiled.args) !== null }
  }

  facetObjects(params: FacetObjectsInput): FacetObjectsResult {
    const source = this.source
    const compiled = compileObjectQuery(params.projectId, stripOuterRowShape(params.query), {
      source,
    })
    return {
      facets: params.facets.map((facet) => ({
        propertyId: facet.propertyId,
        buckets: readFacetBuckets(this.db, compiled, facet),
      })),
    }
  }

  getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): ObjectRow | null {
    const source = this.source
    const objectsTable = source.objectsTable
    const statement = source.wrapStatement(
      `SELECT * FROM ${objectsTable} WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`,
      [params.projectId, params.objectTypeId, params.primaryId]
    )
    const row = this.db.query(statement.sql).get(...statement.args) as DatabaseRow | null

    return row ? rowToObject(row) : null
  }

  selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): readonly boolean[] {
    const source = this.source
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const requestedType = "CAST(json_extract(requested.value, '$.objectTypeId') AS TEXT)"
    const requestedId = "CAST(json_extract(requested.value, '$.primaryId') AS TEXT)"
    const requestedProperty = "CAST(json_extract(requested.value, '$.propertyId') AS TEXT)"
    const selected = "objectPropertyPermissionsTable" in source
    const storedTable = selected ? source.objectPropertyPermissionsTable : source.objectsTable
    const propertyJoin = selected ? `AND stored.property_id = ${requestedProperty}` : ""
    const statement = source.wrapStatement(
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

  listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): readonly ObjectLinkRow[] {
    const source = this.source
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

    const statement = source.wrapStatement(query, args)
    const rows = this.db.query(statement.sql).all(...statement.args) as LinkDatabaseRow[]

    return rows.map((row) => rowToLink(row))
  }

  getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Map<ObjectBatchKey, ObjectRow> {
    const source = this.source
    const result = new Map<ObjectBatchKey, ObjectRow>()
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = source.wrapStatement(
      `
        SELECT
          object.*,
          CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
        FROM json_each(?) AS requested
        JOIN ${source.objectsTable} AS object
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
      if (row) result.set(objectBatchKey(item.objectTypeId, item.primaryId), rowToObject(row))
    }
    return result
  }

  listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Map<LinkBatchKey, ObjectLinkRow[]> {
    const source = this.source
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
    const statement = source.wrapStatement(
      `
        SELECT
          stored.*,
          CAST(json_extract(requested.value, '$.batchIndex') AS INTEGER) AS _batch_index
        FROM ${source.linksTable} AS stored
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
      const link = rowToLink(row)
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

  queryLinks(params: QueryObjectLinksInput): QueryObjectLinksResult {
    const source = this.source
    if (params.objectRefs.length === 0 || params.endpointObjectTypeIds?.length === 0) {
      return { links: [], hasMore: false }
    }

    const requested = `
      SELECT DISTINCT
        json_extract(value, '$.objectTypeId') AS object_type_id,
        json_extract(value, '$.primaryId') AS object_id
      FROM json_each(?)
    `
    const linksTable = source.linksTable
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
    const statement = source.wrapStatement(
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
      links: rows.slice(0, params.limit).map((row) => rowToLink(row)),
      hasMore: rows.length > params.limit,
    }
  }

  list(params: Parameters<ObjectReadStorage["list"]>[0]): {
    objects: readonly ObjectRow[]
    hasMore: boolean
    total: number
  } {
    const source = this.source
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
    const countStatement = source.wrapStatement(
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

    const rowsStatement = source.wrapStatement(query, args)
    const rows = this.db.query(rowsStatement.sql).all(...rowsStatement.args) as DatabaseRow[]
    const hasMore = rows.length > limit
    const objects = rows.slice(0, limit).map((row) => rowToObject(row))

    return { objects, hasMore, total }
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

export function assertLinkQueryLimit(limit: number): void {
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

interface LinkBatchDatabaseRow extends LinkDatabaseRow {
  _batch_index: number
}
