import {
  type ObjectQuery,
  ObjectQueryExecutionError,
  type ObjectQueryPredicate,
  type ObjectQuerySetOperation,
  type ObjectQuerySortField,
} from "@sixb/core"

export interface PgObjectQueryPageRow {
  object_type_id: string
  primary_id: string
  properties: unknown
  _cursor_properties?: unknown
}

export interface CompiledPgObjectQuery {
  sql: string
  args: unknown[]
  totalSql: string
  totalArgs: unknown[]
  order: CompiledOrder
  hasMore(rowCount: number, total: number): boolean
  trimRows<T>(rows: readonly T[]): readonly T[]
  nextPageToken(rows: readonly PgObjectQueryPageRow[], rowCount: number): string | undefined
}

interface CompiledPredicate {
  sql: string
  args: unknown[]
}

interface CompiledOrder {
  sql: string
  args: unknown[]
  fields: readonly CompiledOrderField[]
  propertyColumn: string
}

type CompiledOrderField =
  | {
      kind: "property"
      propertyId: string
      direction: "asc" | "desc"
    }
  | {
      kind: "column"
      column: "object_type_id" | "primary_id"
      direction: "asc" | "desc"
    }

interface EncodedPageToken {
  version: 1
  order: readonly string[]
  values: readonly EncodedCursorValue[]
}

interface EncodedCursorValue {
  nullish: boolean
  value?: unknown
}

const PAGE_TOKEN_PREFIX = "keyset:"

export function compilePgObjectQuery(projectId: string, query: ObjectQuery): CompiledPgObjectQuery {
  const compiled = compileObjectQueryInternal(projectId, query)
  return {
    ...compiled,
    sql: numberPlaceholders(compiled.sql),
    totalSql: numberPlaceholders(compiled.totalSql),
  }
}

function compileObjectQueryInternal(projectId: string, query: ObjectQuery): CompiledPgObjectQuery {
  switch (query.kind) {
    case "start":
      return compileStart(projectId, query)
    case "filter":
      return compileFilter(projectId, query.input, query.predicate)
    case "sort":
      return compileSort(projectId, query.input, query.fields)
    case "limit":
      return compileLimit(projectId, query.input, query.limit)
    case "page":
      return compilePage(projectId, query.input, query.pageSize, query.pageToken)
    case "traverse":
      return compileTraversal(projectId, query.input, query.linkId, query.direction)
    case "set":
      return compileSet(projectId, query.op, query.inputs)
    case "project":
      return compileProject(projectId, query.input, query.properties)
    case "text":
      return compileText(
        projectId,
        query.input,
        query.query,
        query.fields,
        query.fieldsByObjectType
      )
    case "vector":
      throw new Error(`[SixbPg] PostgreSQL object storage does not support query node 'vector'`)
  }
}

function compileStart(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "start" }>
): CompiledPgObjectQuery {
  if (query.includeSubtypes === true) {
    throw new Error("[SixbPg] PostgreSQL object storage does not support start.includeSubtypes")
  }

  const order = compileOrder(identityOrderFields())
  const sql = `
    SELECT *, properties AS _cursor_properties
    FROM objects
    WHERE project_id = ? AND object_type_id = ?
    ORDER BY ${order.sql}
  `

  return {
    sql,
    args: [projectId, query.objectTypeId, ...order.args],
    totalSql:
      "SELECT COUNT(*)::bigint AS total FROM objects WHERE project_id = ? AND object_type_id = ?",
    totalArgs: [projectId, query.objectTypeId],
    order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileFilter(
  projectId: string,
  inputQuery: ObjectQuery,
  predicateNode: ObjectQueryPredicate
): CompiledPgObjectQuery {
  return compileWhere(projectId, inputQuery, compilePredicate(predicateNode))
}

function compileWhere(
  projectId: string,
  inputQuery: ObjectQuery,
  predicate: CompiledPredicate
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  const sql = `
    SELECT *
    FROM (${input.sql}) AS input
    WHERE ${predicate.sql}
    ORDER BY ${input.order.sql}
  `

  return {
    sql,
    args: [...input.args, ...predicate.args, ...input.order.args],
    totalSql: `
      SELECT COUNT(*)::bigint AS total
      FROM (${input.sql}) AS input
      WHERE ${predicate.sql}
    `,
    totalArgs: [...input.args, ...predicate.args],
    order: input.order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileText(
  projectId: string,
  inputQuery: ObjectQuery,
  query: string,
  fields: readonly string[] | undefined,
  fieldsByObjectType: Readonly<Record<string, readonly string[]>> | undefined
): CompiledPgObjectQuery {
  const predicate =
    fields && fields.length > 0
      ? compileTextPredicate(query, fields)
      : compileScopedTextPredicate(query, fieldsByObjectType)

  if (!predicate) {
    throw new Error(
      "[SixbPg] PostgreSQL object text search requires fields or resolved text defaults"
    )
  }
  return compileWhere(projectId, inputQuery, predicate)
}

function compileSort(
  projectId: string,
  inputQuery: ObjectQuery,
  fields: readonly ObjectQuerySortField[]
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  const order = compileOrder(sortOrderFields(fields))

  return {
    sql: `
      SELECT
        input.project_id,
        input.object_type_id,
        input.primary_id,
        input.properties,
        input.properties AS _cursor_properties,
        input.created_at,
        input.updated_at,
        input.version,
        input.source_event_id
      FROM (${input.sql}) AS input
      ORDER BY ${order.sql}
    `,
    args: [...input.args, ...order.args],
    totalSql: input.totalSql,
    totalArgs: input.totalArgs,
    order,
    hasMore: input.hasMore,
    trimRows: input.trimRows,
    nextPageToken: input.nextPageToken,
  }
}

function compileLimit(
  projectId: string,
  inputQuery: ObjectQuery,
  rawLimit: number
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  const limit = Math.max(0, rawLimit)

  return {
    sql: `
      SELECT *
      FROM (${input.sql}) AS input
      ORDER BY ${input.order.sql}
      LIMIT ?
    `,
    args: [...input.args, ...input.order.args, limit],
    totalSql: `
      SELECT COUNT(*)::bigint AS total
      FROM (${input.sql}) AS input
    `,
    totalArgs: input.args,
    order: input.order,
    hasMore: (_rowCount, total) => limit < total,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compilePage(
  projectId: string,
  inputQuery: ObjectQuery,
  rawPageSize: number,
  pageToken: string | undefined
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  const pageSize = Math.max(0, rawPageSize)
  const cursor = pageToken ? decodePageToken(pageToken, input.order.fields) : undefined
  const cursorPredicate = cursor
    ? compileKeysetPredicate(input.order.fields, cursor, input.order.propertyColumn)
    : undefined
  const whereSql = cursorPredicate ? `WHERE ${cursorPredicate.sql}` : ""

  return {
    sql: `
      SELECT *
      FROM (${input.sql}) AS input
      ${whereSql}
      ORDER BY ${input.order.sql}
      LIMIT ?
    `,
    args: [...input.args, ...(cursorPredicate?.args ?? []), ...input.order.args, pageSize + 1],
    totalSql: `
      SELECT COUNT(*)::bigint AS total
      FROM (${input.sql}) AS input
    `,
    totalArgs: input.args,
    order: input.order,
    hasMore: (rowCount) => rowCount > pageSize,
    trimRows: (rows) => rows.slice(0, pageSize),
    nextPageToken: (rows, rowCount) => {
      if (rowCount <= pageSize || rows.length === 0) return undefined
      return encodePageToken(rows[rows.length - 1], input.order.fields)
    },
  }
}

function compileTraversal(
  projectId: string,
  inputQuery: ObjectQuery,
  linkId: string,
  direction: "outgoing" | "incoming"
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  const outputAlias = direction === "outgoing" ? "target_object" : "source_object"
  const joinSql =
    direction === "outgoing"
      ? `
        JOIN links AS edge
          ON edge.project_id = input.project_id
         AND edge.source_type_id = input.object_type_id
         AND edge.source_id = input.primary_id
         AND edge.link_id = ?
        JOIN objects AS target_object
          ON target_object.project_id = edge.project_id
         AND target_object.object_type_id = edge.target_type_id
         AND target_object.primary_id = edge.target_id
      `
      : `
        JOIN links AS edge
          ON edge.project_id = input.project_id
         AND edge.target_type_id = input.object_type_id
         AND edge.target_id = input.primary_id
         AND edge.link_id = ?
        JOIN objects AS source_object
          ON source_object.project_id = edge.project_id
         AND source_object.object_type_id = edge.source_type_id
         AND source_object.primary_id = edge.source_id
      `
  const order = compileOrder(identityOrderFields())
  const qualifiedOrder = compileOrder(identityOrderFields(), outputAlias)
  const sql = `
    SELECT DISTINCT ${outputAlias}.*, ${outputAlias}.properties AS _cursor_properties
    FROM (${input.sql}) AS input
    ${joinSql}
    ORDER BY ${qualifiedOrder.sql}
  `
  const args = [...input.args, linkId, ...qualifiedOrder.args]

  return {
    sql,
    args,
    totalSql: `SELECT COUNT(*)::bigint AS total FROM (${sql}) AS traversed`,
    totalArgs: args,
    order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileSet(
  projectId: string,
  op: ObjectQuerySetOperation,
  inputs: readonly ObjectQuery[]
): CompiledPgObjectQuery {
  if (inputs.length === 0) {
    const order = compileOrder(identityOrderFields())
    return {
      sql: `
        SELECT *, properties AS _cursor_properties
        FROM objects
        WHERE 1 = 0
        ORDER BY ${order.sql}
      `,
      args: order.args,
      totalSql: "SELECT 0::bigint AS total",
      totalArgs: [],
      order,
      hasMore: () => false,
      trimRows: identityRows,
      nextPageToken: () => undefined,
    }
  }

  const compiledInputs = inputs.map((input) => compileObjectQueryInternal(projectId, input))
  const identities = compileSetIdentities(op, compiledInputs)
  const order = compileOrder(identityOrderFields())
  const selectedOrder = compileOrder(identityOrderFields(), "selected")
  const sql = `
    SELECT selected.*, selected.properties AS _cursor_properties
    FROM (${identities.sql}) AS ids
    JOIN objects AS selected
      ON selected.project_id = ?
     AND selected.object_type_id = ids.object_type_id
     AND selected.primary_id = ids.primary_id
    ORDER BY ${selectedOrder.sql}
  `

  return {
    sql,
    args: [...identities.args, projectId, ...selectedOrder.args],
    totalSql: `SELECT COUNT(*)::bigint AS total FROM (${identities.sql}) AS ids`,
    totalArgs: identities.args,
    order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileProject(
  projectId: string,
  inputQuery: ObjectQuery,
  properties: readonly string[] | undefined
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery)
  if (!properties) return input

  const projection = compileProjectionExpression(properties)
  const inputOrder = compileOrder(input.order.fields, "input", "input._cursor_properties")
  const outputOrder = compileOrder(input.order.fields, undefined, "_cursor_properties")

  return {
    sql: `
      SELECT
        input.project_id,
        input.object_type_id,
        input.primary_id,
        ${projection.sql} AS properties,
        input._cursor_properties AS _cursor_properties,
        input.created_at,
        input.updated_at,
        input.version,
        input.source_event_id
      FROM (${input.sql}) AS input
      ORDER BY ${inputOrder.sql}
    `,
    args: [...projection.args, ...input.args, ...inputOrder.args],
    totalSql: input.totalSql,
    totalArgs: input.totalArgs,
    order: outputOrder,
    hasMore: input.hasMore,
    trimRows: input.trimRows,
    nextPageToken: input.nextPageToken,
  }
}

function compileSetIdentities(
  op: ObjectQuerySetOperation,
  inputs: readonly CompiledPgObjectQuery[]
): CompiledPredicate {
  const operator = op === "union" ? "UNION" : op === "intersect" ? "INTERSECT" : "EXCEPT"
  const identitySqls = inputs.map(
    (input) => `SELECT object_type_id, primary_id FROM (${input.sql}) AS input`
  )

  return {
    sql: identitySqls.join(` ${operator} `),
    args: inputs.flatMap((input) => input.args),
  }
}

function compileProjectionExpression(properties: readonly string[]): CompiledPredicate {
  if (properties.length === 0) return { sql: "'{}'::jsonb", args: [] }

  return {
    sql: `
      COALESCE(
        (
          SELECT jsonb_object_agg(projected.key, projected.value)
          FROM jsonb_each(input.properties) AS projected(key, value)
          WHERE projected.key IN (${properties.map(() => "?::text").join(", ")})
        ),
        '{}'::jsonb
      )
    `,
    args: [...properties],
  }
}

function compilePredicate(predicate: ObjectQueryPredicate): CompiledPredicate {
  switch (predicate.op) {
    case "and":
    case "or": {
      const items = predicate.items.map(compilePredicate)
      const joiner = predicate.op === "and" ? " AND " : " OR "
      return {
        sql: `(${items.map((item) => item.sql).join(joiner)})`,
        args: items.flatMap((item) => item.args),
      }
    }
    case "not": {
      const item = compilePredicate(predicate.item)
      return negatePredicate(item)
    }
    case "eq":
      return compileEqualityPredicate(predicate.propertyId, "eq", predicate.value)
    case "neq":
      return compileEqualityPredicate(predicate.propertyId, "neq", predicate.value)
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const op = sqlComparisonOperator(predicate.op)
      return {
        sql: `${jsonValueExpression()} ${op} ?::text::jsonb`,
        args: [predicate.propertyId, jsonbValue(predicate.value)],
      }
    }
    case "in":
      return compileInPredicate(predicate.propertyId, predicate.values)
    case "exists": {
      const sql = `jsonb_exists(properties, ?::text)`
      const item: CompiledPredicate = { sql, args: [predicate.propertyId] }
      return predicate.value ? item : negatePredicate(item)
    }
    case "contains":
      return compileContainsPredicate(predicate.propertyId, predicate.value)
  }
}

function negatePredicate(predicate: CompiledPredicate): CompiledPredicate {
  return {
    sql: `(NOT COALESCE((${predicate.sql}), false))`,
    args: predicate.args,
  }
}

function compileEqualityPredicate(
  propertyId: string,
  op: "eq" | "neq",
  value: unknown
): CompiledPredicate {
  if (value === null) {
    const sql = `${jsonTypeExpression()} = 'null'`
    const item: CompiledPredicate = { sql, args: [propertyId] }
    return op === "eq" ? item : negatePredicate(item)
  }

  if (op === "eq") {
    return {
      sql: `${jsonValueExpression()} = ?::text::jsonb`,
      args: [propertyId, jsonbValue(value)],
    }
  }

  return {
    sql: `(${jsonTypeExpression()} IS NULL OR ${jsonTypeExpression()} = 'null' OR ${jsonValueExpression()} <> ?::text::jsonb)`,
    args: [propertyId, propertyId, propertyId, jsonbValue(value)],
  }
}

function compileInPredicate(propertyId: string, values: readonly unknown[]): CompiledPredicate {
  if (values.length === 0) return { sql: "0 = 1", args: [] }

  const nonNullValues = values.filter((value) => value !== null)
  const clauses: string[] = []
  const args: unknown[] = []

  if (values.length !== nonNullValues.length) {
    clauses.push(`${jsonTypeExpression()} = 'null'`)
    args.push(propertyId)
  }

  if (nonNullValues.length > 0) {
    clauses.push(
      `${jsonValueExpression()} IN (${nonNullValues.map(() => "?::text::jsonb").join(", ")})`
    )
    args.push(propertyId, ...nonNullValues.map(jsonbValue))
  }

  return {
    sql: `(${clauses.join(" OR ")})`,
    args,
  }
}

function compileContainsPredicate(propertyId: string, value: unknown): CompiledPredicate {
  const clauses: string[] = []
  const args: unknown[] = []

  if (typeof value === "string") {
    clauses.push(
      `(${jsonTypeExpression()} = 'string' AND position(?::text in ${jsonTextExpression()}) > 0)`
    )
    args.push(propertyId, value, propertyId)
  }

  clauses.push(
    `(${jsonTypeExpression()} = 'array' AND ${jsonValueExpression()} @> jsonb_build_array(?::text::jsonb))`
  )
  args.push(propertyId, propertyId, jsonbValue(value))

  if (typeof value === "string") {
    clauses.push(
      `(${jsonTypeExpression()} = 'object' AND jsonb_exists(${jsonValueExpression()}, ?::text))`
    )
    args.push(propertyId, propertyId, value)
  }

  return { sql: `(${clauses.join(" OR ")})`, args }
}

function compileTextPredicate(query: string, fields: readonly string[]): CompiledPredicate {
  const terms = tokenize(query)
  if (terms.length === 0) return { sql: "0 = 1", args: [] }

  const clauses = terms.map(() => {
    const fieldClauses = fields.map(
      () => `position(?::text in lower(coalesce(${jsonTextExpression()}, ''))) > 0`
    )
    return `(${fieldClauses.join(" OR ")})`
  })
  const args = terms.flatMap((term) => fields.flatMap((field) => [term, field]))

  return { sql: `(${clauses.join(" AND ")})`, args }
}

function compileScopedTextPredicate(
  query: string,
  fieldsByObjectType: Readonly<Record<string, readonly string[]>> | undefined
): CompiledPredicate | null {
  const scopedPredicates: CompiledPredicate[] = []

  for (const [objectTypeId, fields] of Object.entries(fieldsByObjectType ?? {})) {
    if (fields.length === 0) continue
    const predicate = compileTextPredicate(query, fields)
    scopedPredicates.push({
      sql: `(object_type_id = ? AND ${predicate.sql})`,
      args: [objectTypeId, ...predicate.args],
    })
  }

  if (scopedPredicates.length === 0) return null

  return {
    sql: `(${scopedPredicates.map((predicate) => predicate.sql).join(" OR ")})`,
    args: scopedPredicates.flatMap((predicate) => predicate.args),
  }
}

function compileOrder(
  fields: readonly CompiledOrderField[],
  qualifier?: string,
  propertyColumn = "properties"
): CompiledOrder {
  const clauses: string[] = []
  const args: unknown[] = []

  for (const field of fields) {
    if (field.kind === "column") {
      clauses.push(`${columnExpression(field.column, qualifier)} ${field.direction.toUpperCase()}`)
      continue
    }

    const direction = field.direction === "desc" ? "DESC" : "ASC"
    clauses.push(
      `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END ASC`,
      `${jsonValueExpression(propertyColumn)} ${direction}`
    )
    args.push(field.propertyId, field.propertyId, field.propertyId)
  }

  return { sql: clauses.join(", "), args, fields, propertyColumn }
}

function sortOrderFields(fields: readonly ObjectQuerySortField[]): readonly CompiledOrderField[] {
  const orderFields: CompiledOrderField[] = []
  for (const field of fields) {
    if (field.kind !== "property") {
      throw new Error("[SixbPg] PostgreSQL object storage does not support relevance sorting")
    }

    orderFields.push({
      kind: "property",
      propertyId: field.propertyId,
      direction: field.direction === "desc" ? "desc" : "asc",
    })
  }
  orderFields.push(...identityOrderFields())
  return orderFields
}

function identityOrderFields(): readonly CompiledOrderField[] {
  return [
    { kind: "column", column: "object_type_id", direction: "asc" },
    { kind: "column", column: "primary_id", direction: "asc" },
  ]
}

function compileKeysetPredicate(
  fields: readonly CompiledOrderField[],
  cursor: readonly EncodedCursorValue[],
  propertyColumn = "properties"
): CompiledPredicate {
  const disjuncts: CompiledPredicate[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const equalityPredicates = fields
      .slice(0, index)
      .map((field, equalityIndex) =>
        compileFieldEquality(field, cursor[equalityIndex], propertyColumn)
      )
    const advancePredicate = compileFieldAfter(fields[index], cursor[index], propertyColumn)
    if (!advancePredicate) continue

    const parts = [...equalityPredicates, advancePredicate]
    disjuncts.push({
      sql: `(${parts.map((part) => part.sql).join(" AND ")})`,
      args: parts.flatMap((part) => part.args),
    })
  }

  if (disjuncts.length === 0) return { sql: "0 = 1", args: [] }

  return {
    sql: `(${disjuncts.map((part) => part.sql).join(" OR ")})`,
    args: disjuncts.flatMap((part) => part.args),
  }
}

function compileFieldEquality(
  field: CompiledOrderField,
  cursor: EncodedCursorValue,
  propertyColumn = "properties"
): CompiledPredicate {
  if (field.kind === "column") {
    return {
      sql: `${columnExpression(field.column)} = ?`,
      args: [cursor.value],
    }
  }

  if (cursor.nullish) {
    return {
      sql: `(${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null')`,
      args: [field.propertyId, field.propertyId],
    }
  }

  return {
    sql: `(${jsonTypeExpression(propertyColumn)} IS NOT NULL AND ${jsonTypeExpression(propertyColumn)} != 'null' AND ${jsonValueExpression(propertyColumn)} = ?::text::jsonb)`,
    args: [field.propertyId, field.propertyId, field.propertyId, jsonbValue(cursor.value)],
  }
}

function compileFieldAfter(
  field: CompiledOrderField,
  cursor: EncodedCursorValue,
  propertyColumn = "properties"
): CompiledPredicate | null {
  if (field.kind === "column") {
    return {
      sql: `${columnExpression(field.column)} ${field.direction === "desc" ? "<" : ">"} ?`,
      args: [cursor.value],
    }
  }

  if (cursor.nullish) return null

  const rankSql = `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END`
  const valueOperator = field.direction === "desc" ? "<" : ">"

  return {
    sql: `(${rankSql} > 0 OR (${rankSql} = 0 AND ${jsonValueExpression(propertyColumn)} ${valueOperator} ?::text::jsonb))`,
    args: [
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.propertyId,
      jsonbValue(cursor.value),
    ],
  }
}

function encodePageToken(row: PgObjectQueryPageRow, fields: readonly CompiledOrderField[]): string {
  const properties = objectProperties(row._cursor_properties ?? row.properties)
  const token: EncodedPageToken = {
    version: 1,
    order: fields.map(orderFieldKey),
    values: fields.map((field) => cursorValueForField(row, properties, field)),
  }
  return `${PAGE_TOKEN_PREFIX}${Buffer.from(JSON.stringify(token)).toString("base64url")}`
}

function decodePageToken(
  token: string,
  fields: readonly CompiledOrderField[]
): readonly EncodedCursorValue[] {
  if (!token.startsWith(PAGE_TOKEN_PREFIX)) {
    throwInvalidPageToken("Invalid PostgreSQL object query page token")
  }

  const raw = token.slice(PAGE_TOKEN_PREFIX.length)
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throwInvalidPageToken("Invalid PostgreSQL object query page token")
  }

  if (!isEncodedPageToken(decoded)) {
    throwInvalidPageToken("Invalid PostgreSQL object query page token")
  }

  const expectedOrder = fields.map(orderFieldKey)
  if (
    decoded.order.length !== expectedOrder.length ||
    decoded.order.some((field, index) => field !== expectedOrder[index])
  ) {
    throwInvalidPageToken("PostgreSQL object query page token does not match query order")
  }

  return decoded.values
}

function throwInvalidPageToken(message: string): never {
  throw new ObjectQueryExecutionError("invalid_page_token", message, "$.pageToken")
}

function isEncodedPageToken(value: unknown): value is EncodedPageToken {
  if (!isPlainObject(value)) return false
  if (value.version !== 1) return false
  if (!Array.isArray(value.order) || value.order.some((item) => typeof item !== "string")) {
    return false
  }
  if (!Array.isArray(value.values)) return false
  return value.values.every(
    (item) =>
      isPlainObject(item) &&
      typeof item.nullish === "boolean" &&
      (item.nullish || Object.hasOwn(item, "value"))
  )
}

function cursorValueForField(
  row: PgObjectQueryPageRow,
  properties: Record<string, unknown>,
  field: CompiledOrderField
): EncodedCursorValue {
  const value =
    field.kind === "column"
      ? field.column === "object_type_id"
        ? row.object_type_id
        : row.primary_id
      : properties[field.propertyId]

  return value === null || value === undefined ? { nullish: true } : { nullish: false, value }
}

function orderFieldKey(field: CompiledOrderField): string {
  return field.kind === "column"
    ? `column:${field.column}:${field.direction}`
    : `property:${field.propertyId}:${field.direction}`
}

function columnExpression(column: "object_type_id" | "primary_id", qualifier?: string): string {
  return qualifier ? `${qualifier}.${column}` : column
}

function jsonValueExpression(column = "properties"): string {
  return `${column} -> (?::text)`
}

function jsonTextExpression(column = "properties"): string {
  return `${column} ->> (?::text)`
}

function jsonTypeExpression(column = "properties"): string {
  return `jsonb_typeof(${jsonValueExpression(column)})`
}

function jsonbValue(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  const json = JSON.stringify(value)
  return json === undefined ? "null" : json
}

function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function sqlComparisonOperator(op: "lt" | "lte" | "gt" | "gte"): "<" | "<=" | ">" | ">=" {
  switch (op) {
    case "lt":
      return "<"
    case "lte":
      return "<="
    case "gt":
      return ">"
    case "gte":
      return ">="
  }
}

function numberPlaceholders(sql: string): string {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function objectProperties(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown
    return isPlainObject(parsed) ? parsed : {}
  }

  return isPlainObject(value) ? value : {}
}

function identityRows<T>(rows: readonly T[]): readonly T[] {
  return rows
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
