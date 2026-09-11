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
  ObjectFacetResult,
  ObjectLinkRow,
  ObjectReadStorage,
  ObjectRow,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "@sixb/core/storage"
import { linkBatchKey, objectBatchKey } from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "../pg-client"
import {
  type CompiledPgObjectQuery,
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
  compilePgObjectStatement,
  type PgObjectQuerySource,
} from "./query-compiler"
import type { PgSelectedObjectReadSource } from "./read-scope"

import {
  type FacetDatabaseRow,
  type LinkBatchDatabaseRow,
  type LinkDatabaseRow,
  linkIdentity,
  type ObjectBatchDatabaseRow,
  type ObjectDatabaseRow,
  type ObjectQueryDatabaseRow,
  type PropertyPermissionBatchDatabaseRow,
  queryRowToObject,
  rowToLink,
  rowToObject,
} from "./rows"

export class PgObjectReader {
  constructor(
    private readonly sql: SQLClient,
    private readonly source: PgObjectQuerySource | PgSelectedObjectReadSource
  ) {}

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    const sql = this.sql
    const source = this.source
    const compiled = compilePgObjectQuery(params.projectId, params.query, {
      includeTotal: params.includeTotal,
      source,
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
    const sql = this.sql
    const source = this.source
    const compiled = compilePgObjectCountQuery(params.projectId, stripOuterRowShape(params.query), {
      source,
    })
    const [row] = await sql.unsafe<{ count: string | number | bigint }[]>(
      compiled.sql,
      compiled.args as SqlParameter[]
    )
    return { count: Number(row?.count ?? 0) }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    const sql = this.sql
    const source = this.source
    const compiled = compilePgObjectExistsQuery(
      params.projectId,
      stripOuterRowShape(params.query),
      { source }
    )
    const [row] = await sql.unsafe<unknown[]>(compiled.sql, compiled.args as SqlParameter[])
    return { exists: row !== undefined }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    const sql = this.sql
    const source = this.source
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
            { source }
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
    const sql = this.sql
    const source = this.source
    const statement = compilePgObjectStatement(
      `
        SELECT *
        FROM ${source.objectsTable}
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
    const sql = this.sql
    const source = this.source
    const result = params.items.map(() => false)
    if (params.items.length === 0) return result

    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const selected = "objectPropertyPermissionsTable" in source
    const storedTable = selected ? source.objectPropertyPermissionsTable : source.objectsTable
    const propertyJoin = selected ? 'AND stored.property_id = requested."propertyId"' : ""
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
    const sql = this.sql
    const source = this.source
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
    const query = `SELECT * FROM ${source.linksTable} WHERE project_id = ? AND ${directionWhere}${
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
    const sql = this.sql
    const source = this.source
    const result = new Map<ObjectBatchKey, ObjectRow>()
    if (params.items.length === 0) return result
    const items = params.items.map((item, batchIndex) => ({ ...item, batchIndex }))
    const statement = compilePgObjectStatement(
      `
        SELECT object.*, requested."batchIndex" AS _batch_index
        FROM jsonb_to_recordset(?::text::jsonb)
          AS requested("objectTypeId" text, "primaryId" text, "batchIndex" integer)
        JOIN ${source.objectsTable} AS object
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
    const sql = this.sql
    const source = this.source
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
    const table = source.linksTable
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
    const sql = this.sql
    const source = this.source
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
    const table = source.linksTable
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

  async list(
    params: Parameters<ObjectReadStorage["list"]>[0]
  ): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    const sql = this.sql
    const source = this.source
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

    const objectsTable = source.objectsTable
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

export function assertLinkQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object link query limit must be a positive safe integer.")
  }
}
