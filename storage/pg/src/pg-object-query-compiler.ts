import {
  type ObjectExpansion,
  type ObjectQuery,
  type ObjectQueryPredicate,
  type ObjectQuerySetOperation,
  type ObjectQuerySortField,
  objectQueryExecutionFailed,
  type QueryScalarKind,
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
  hasMoreProbe?: CompiledHasMoreProbe
  hasMore(rowCount: number, total?: number): boolean
  trimRows<T>(rows: readonly T[]): readonly T[]
  nextPageToken(rows: readonly PgObjectQueryPageRow[], rowCount: number): string | undefined
}

export interface CompiledPgScalarQuery {
  sql: string
  args: unknown[]
}

export interface CompiledPgFacetQuery {
  sql: string
  args: unknown[]
}

interface CompiledHasMoreProbe {
  sql: string
  args: unknown[]
  hasMore(rowCount: number): boolean
}

interface CompileContext {
  probeLimit: boolean
}

interface CompiledPredicate {
  sql: string
  args: unknown[]
}

interface CompiledAggregateSource {
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
      scalarKind?: QueryScalarKind
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
const exactContext: CompileContext = { probeLimit: false }
// Per-parent fanout the core executor bakes into every pushed-down expansion;
// this default only guards a malformed (un-baked) IR and mirrors the core cap.
const DEFAULT_EXPANSION_FANOUT = 1_000

export function compilePgObjectQuery(
  projectId: string,
  query: ObjectQuery,
  options: { includeTotal?: boolean } = {}
): CompiledPgObjectQuery {
  const compiled = compileObjectQueryInternal(projectId, query, {
    probeLimit: options.includeTotal === false,
  })
  return {
    ...compiled,
    sql: numberPlaceholders(compiled.sql),
    totalSql: numberPlaceholders(compiled.totalSql),
    hasMoreProbe: compiled.hasMoreProbe
      ? {
          ...compiled.hasMoreProbe,
          sql: numberPlaceholders(compiled.hasMoreProbe.sql),
        }
      : undefined,
  }
}

export function compilePgObjectCountQuery(
  projectId: string,
  query: ObjectQuery
): CompiledPgScalarQuery {
  const source = compileAggregateSource(projectId, query)
  return numberCompiledQuery({
    sql: `
      SELECT COUNT(*)::bigint AS count
      FROM (${source.sql}) AS input
    `,
    args: source.args,
  })
}

export function compilePgObjectExistsQuery(
  projectId: string,
  query: ObjectQuery
): CompiledPgScalarQuery {
  const source = compileAggregateSource(projectId, query)
  return numberCompiledQuery({
    sql: `
      SELECT 1
      FROM (${source.sql}) AS input
      LIMIT 1
    `,
    args: source.args,
  })
}

export function compilePgObjectFacetQuery(
  projectId: string,
  query: ObjectQuery,
  propertyId: string,
  limit: number
): CompiledPgFacetQuery {
  const source = compileAggregateSource(projectId, query)
  return numberCompiledQuery({
    sql: `
      SELECT facet.value_type, facet.value_text, COUNT(*)::bigint AS count
      FROM (
        SELECT
          jsonb_typeof(input.properties -> (?::text)) AS value_type,
          input.properties ->> (?::text) AS value_text
        FROM (${source.sql}) AS input
        WHERE jsonb_exists(input.properties, ?::text)
      ) AS facet
      GROUP BY facet.value_type, facet.value_text
      ORDER BY count DESC, facet.value_text ASC
      LIMIT ?
    `,
    args: [propertyId, propertyId, ...source.args, propertyId, limit],
  })
}

function compileObjectQueryInternal(
  projectId: string,
  query: ObjectQuery,
  ctx: CompileContext
): CompiledPgObjectQuery {
  switch (query.kind) {
    case "start":
      return compileStart(projectId, query)
    case "filter":
      return compileFilter(projectId, query.input, query.predicate)
    case "sort":
      return compileSort(projectId, query.input, query.fields, ctx)
    case "limit":
      return compileLimit(projectId, query.input, query.limit, ctx)
    case "page":
      return compilePage(projectId, query.input, query.pageSize, query.pageToken)
    case "traverse":
      return compileTraversal(
        projectId,
        query.input,
        query.linkId,
        query.direction,
        query.sourceObjectTypeId
      )
    case "set":
      return compileSet(projectId, query.op, query.inputs)
    case "project":
      return compileProject(projectId, query.input, query.properties, ctx)
    case "text":
      return compileText(
        projectId,
        query.input,
        query.query,
        query.fields,
        query.fieldsByObjectType
      )
    case "expand":
      return compileExpand(projectId, query.input, query.expansions)
    case "vector":
      throw new Error(
        `[SixbPg] PostgreSQL object storage does not support query node '${query.kind}'`
      )
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
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
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
  return compileWhere(
    projectId,
    inputQuery,
    compileTextSearchPredicate(query, fields, fieldsByObjectType)
  )
}

function compileSort(
  projectId: string,
  inputQuery: ObjectQuery,
  fields: readonly ObjectQuerySortField[],
  ctx: CompileContext
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
  const probeInput =
    ctx.probeLimit && needsLimitProbe(inputQuery)
      ? compileObjectQueryInternal(projectId, inputQuery, ctx)
      : undefined
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
        input.last_commit_id
      FROM (${input.sql}) AS input
      ORDER BY ${order.sql}
    `,
    args: [...input.args, ...order.args],
    totalSql: input.totalSql,
    totalArgs: input.totalArgs,
    order,
    hasMoreProbe: probeInput ? hasMoreProbeFor(probeInput) : input.hasMoreProbe,
    hasMore: input.hasMore,
    trimRows: input.trimRows,
    nextPageToken: input.nextPageToken,
  }
}

function compileLimit(
  projectId: string,
  inputQuery: ObjectQuery,
  rawLimit: number,
  ctx: CompileContext
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
  const limit = Math.max(0, rawLimit)
  const rowLimit = ctx.probeLimit ? limit + 1 : limit

  return {
    sql: `
      SELECT *
      FROM (${input.sql}) AS input
      ORDER BY ${input.order.sql}
      LIMIT ?
    `,
    args: [...input.args, ...input.order.args, rowLimit],
    totalSql: `
      SELECT COUNT(*)::bigint AS total
      FROM (${input.sql}) AS input
    `,
    totalArgs: input.args,
    order: input.order,
    hasMore: (rowCount, total) =>
      total === undefined ? ctx.probeLimit && rowCount > limit : limit < total,
    trimRows: ctx.probeLimit ? (rows) => rows.slice(0, limit) : identityRows,
    nextPageToken: () => undefined,
  }
}

function compilePage(
  projectId: string,
  inputQuery: ObjectQuery,
  rawPageSize: number,
  pageToken: string | undefined
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
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
  direction: "outgoing" | "incoming",
  sourceObjectTypeId?: string
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
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
         AND edge.link_id = ?${sourceObjectTypeId === undefined ? "" : "\n         AND edge.source_type_id = ?"}
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
  const args = [
    ...input.args,
    linkId,
    ...(sourceObjectTypeId === undefined ? [] : [sourceObjectTypeId]),
    ...qualifiedOrder.args,
  ]

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

/** Correlation handle for an expansion: the parent row's identity columns. */
interface ExpansionParent {
  project: string
  type: string
  id: string
}

// `expand` attaches linked objects to each result row without changing which
// objects match (unlike `traverse`, which pivots to the targets). Each expansion
// becomes a correlated subquery that hydrates its links into a JSONB value, and
// all expansions are folded into one `_expand` object column the row mapper reads
// back. The input set is otherwise untouched, so pagination/order pass through.
function compileExpand(
  projectId: string,
  inputQuery: ObjectQuery,
  expansions: readonly ObjectExpansion[]
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext)
  const expand = compileExpansionsObject(
    expansions,
    { project: "input.project_id", type: "input.object_type_id", id: "input.primary_id" },
    ""
  )
  const inputOrder = compileOrder(input.order.fields, "input", "input._cursor_properties")
  const sql = `
    SELECT input.*, ${expand.sql} AS _expand
    FROM (${input.sql}) AS input
    ORDER BY ${inputOrder.sql}
  `

  return {
    sql,
    args: [...expand.args, ...input.args, ...inputOrder.args],
    totalSql: input.totalSql,
    totalArgs: input.totalArgs,
    order: input.order,
    hasMoreProbe: input.hasMoreProbe,
    hasMore: input.hasMore,
    trimRows: input.trimRows,
    nextPageToken: input.nextPageToken,
  }
}

// `jsonb_build_object(linkId, value, ...)` over a set of expansions sharing one
// parent. Link ids are user data, so they ride as parameters. Used both for the
// outer `_expand` column and for each child's nested `links`.
function compileExpansionsObject(
  expansions: readonly ObjectExpansion[],
  parent: ExpansionParent,
  pathPrefix: string
): CompiledPredicate {
  const parts: string[] = []
  const args: unknown[] = []
  expansions.forEach((expansion, index) => {
    const path = pathPrefix === "" ? `${index}` : `${pathPrefix}_${index}`
    const value = compileExpansionValue(expansion, parent, path)
    parts.push("?::text", value.sql)
    args.push(expansion.linkId, ...value.args)
  })
  return { sql: `jsonb_build_object(${parts.join(", ")})`, args }
}

// One expansion's hydrated value. `row_number()` numbers a parent's links by the
// order from `compileExpansionOrder` (the expansion's `orderBy` against the target
// object's properties, then an identity tiebreak); `WHERE _ord <= N` keeps the
// top-N per parent in-DB; each retained neighbour becomes a JSONB object; and the
// value is an ordered array ("many") or the first element or null ("one"). The
// cardinality is core-resolved before pushdown.
function compileExpansionValue(
  expansion: ObjectExpansion,
  parent: ExpansionParent,
  path: string
): CompiledPredicate {
  const edge = `edge_${path}`
  const target = `tgt_${path}`
  const ranked = `ranked_${path}`
  const incoming = expansion.direction === "incoming"
  // The hydrated neighbour is the link target (outgoing) or source (incoming);
  // the parent sits on the opposite end, mirroring `compileTraversal`.
  const neighborType = incoming ? `${edge}.source_type_id` : `${edge}.target_type_id`
  const neighborId = incoming ? `${edge}.source_id` : `${edge}.target_id`
  const parentType = incoming ? `${edge}.target_type_id` : `${edge}.source_type_id`
  const parentId = incoming ? `${edge}.target_id` : `${edge}.source_id`

  const child = compileExpansionChildJson(expansion, edge, target, path)
  const order = compileExpansionOrder(expansion, target, neighborType, neighborId)

  const whereParts = [
    `${edge}.project_id = ${parent.project}`,
    `${parentType} = ${parent.type}`,
    `${parentId} = ${parent.id}`,
    `${edge}.link_id = ?::text`,
  ]
  const whereArgs: unknown[] = [expansion.linkId]
  if (incoming && expansion.sourceObjectTypeId !== undefined) {
    whereParts.push(`${edge}.source_type_id = ?::text`)
    whereArgs.push(expansion.sourceObjectTypeId)
  }

  const inner = `
    SELECT ${child.sql} AS elem, row_number() OVER (ORDER BY ${order.sql}) AS _ord
    FROM links AS ${edge}
    JOIN objects AS ${target}
      ON ${target}.project_id = ${edge}.project_id
     AND ${target}.object_type_id = ${neighborType}
     AND ${target}.primary_id = ${neighborId}
    WHERE ${whereParts.join(" AND ")}
  `
  const innerArgs = [...child.args, ...order.args, ...whereArgs]

  if (expansion.cardinality === "one") {
    return {
      sql: `(SELECT ${ranked}.elem FROM (${inner}) AS ${ranked} WHERE ${ranked}._ord = 1)`,
      args: innerArgs,
    }
  }

  // The fanout cap is baked into `limit` by the core executor before pushdown.
  const limit = expansion.limit ?? DEFAULT_EXPANSION_FANOUT
  return {
    sql: `COALESCE((SELECT jsonb_agg(${ranked}.elem ORDER BY ${ranked}._ord) FROM (${inner}) AS ${ranked} WHERE ${ranked}._ord <= ?), '[]'::jsonb)`,
    args: [...innerArgs, limit],
  }
}

// Build one hydrated neighbour as an `ExpandedObjectRow`-shaped JSONB object.
// `linkProperties` always rides along (the mapper drops it when empty), and
// nested expansions recurse under `links`, correlated on this neighbour.
function compileExpansionChildJson(
  expansion: ObjectExpansion,
  edge: string,
  target: string,
  path: string
): CompiledPredicate {
  const fields = [
    `'projectId', ${target}.project_id`,
    `'objectTypeId', ${target}.object_type_id`,
    `'primaryId', ${target}.primary_id`,
    `'properties', ${target}.properties`,
    `'createdAt', ${target}.created_at`,
    `'updatedAt', ${target}.updated_at`,
    `'version', ${target}.version`,
    `'lastCommitId', ${target}.last_commit_id`,
    `'linkProperties', ${edge}.properties`,
  ]
  const args: unknown[] = []

  if (expansion.expand && expansion.expand.length > 0) {
    const nested = compileExpansionsObject(
      expansion.expand,
      {
        project: `${target}.project_id`,
        type: `${target}.object_type_id`,
        id: `${target}.primary_id`,
      },
      path
    )
    fields.push(`'links', ${nested.sql}`)
    args.push(...nested.args)
  }

  return { sql: `jsonb_build_object(${fields.join(", ")})`, args }
}

// Order a parent's links the way the fallback's per-parent trim does: each
// property sorts nulls last with the requested direction (against the neighbour's
// JSONB properties), then a deterministic identity tiebreak on the neighbour.
function compileExpansionOrder(
  expansion: ObjectExpansion,
  target: string,
  neighborType: string,
  neighborId: string
): CompiledPredicate {
  const propertyColumn = `${target}.properties`
  const clauses: string[] = []
  const args: unknown[] = []

  for (const field of expansion.orderBy ?? []) {
    // Relevance is a no-op in the fallback comparator; mirror that by skipping it.
    if (field.kind !== "property") continue
    const direction = field.direction === "desc" ? "DESC" : "ASC"
    clauses.push(
      `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END ASC`,
      `${
        field.scalarKind === "decimal"
          ? `(${jsonTextExpression(propertyColumn)})::numeric`
          : jsonValueExpression(propertyColumn)
      } ${direction}`
    )
    args.push(field.propertyId, field.propertyId, field.propertyId)
  }

  clauses.push(`${neighborType} ASC`, `${neighborId} ASC`)
  return { sql: clauses.join(", "), args }
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

  const compiledInputs = inputs.map((input) =>
    compileObjectQueryInternal(projectId, input, exactContext)
  )
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
  properties: readonly string[] | undefined,
  ctx: CompileContext
): CompiledPgObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, ctx)
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
        input.last_commit_id
      FROM (${input.sql}) AS input
      ORDER BY ${inputOrder.sql}
    `,
    args: [...projection.args, ...input.args, ...inputOrder.args],
    totalSql: input.totalSql,
    totalArgs: input.totalArgs,
    order: outputOrder,
    hasMoreProbe: input.hasMoreProbe,
    hasMore: input.hasMore,
    trimRows: input.trimRows,
    nextPageToken: input.nextPageToken,
  }
}

function compileAggregateSource(projectId: string, query: ObjectQuery): CompiledAggregateSource {
  switch (query.kind) {
    case "start":
      return compileAggregateStart(projectId, query)
    case "filter":
      return compileAggregateWhere(projectId, query.input, compilePredicate(query.predicate))
    case "text": {
      return compileAggregateWhere(
        projectId,
        query.input,
        compileTextSearchPredicate(query.query, query.fields, query.fieldsByObjectType)
      )
    }
    case "traverse":
      return compileAggregateTraversal(
        projectId,
        query.input,
        query.linkId,
        query.direction,
        query.sourceObjectTypeId
      )
    case "set":
      return compileAggregateSet(projectId, query.op, query.inputs)
    case "sort":
    case "project":
    // `expand` is output-shaping, like sort/project: aggregates ignore it.
    case "expand":
      return compileAggregateSource(projectId, query.input)
    case "limit":
    case "page":
      return compileRowQueryAggregateSource(projectId, query)
    case "vector":
      throw new Error(`[SixbPg] PostgreSQL object storage does not support query node 'vector'`)
  }
}

function compileAggregateStart(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "start" }>
): CompiledAggregateSource {
  if (query.includeSubtypes === true) {
    throw new Error("[SixbPg] PostgreSQL object storage does not support start.includeSubtypes")
  }

  return {
    sql: `
      SELECT project_id, object_type_id, primary_id, properties
      FROM objects
      WHERE project_id = ? AND object_type_id = ?
    `,
    args: [projectId, query.objectTypeId],
  }
}

function compileAggregateWhere(
  projectId: string,
  inputQuery: ObjectQuery,
  predicate: CompiledPredicate
): CompiledAggregateSource {
  const input = compileAggregateSource(projectId, inputQuery)
  return {
    sql: `
      SELECT input.project_id, input.object_type_id, input.primary_id, input.properties
      FROM (${input.sql}) AS input
      WHERE ${predicate.sql}
    `,
    args: [...input.args, ...predicate.args],
  }
}

function compileAggregateTraversal(
  projectId: string,
  inputQuery: ObjectQuery,
  linkId: string,
  direction: "outgoing" | "incoming",
  sourceObjectTypeId?: string
): CompiledAggregateSource {
  const input = compileAggregateSource(projectId, inputQuery)
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
         AND edge.link_id = ?${sourceObjectTypeId === undefined ? "" : "\n         AND edge.source_type_id = ?"}
        JOIN objects AS source_object
          ON source_object.project_id = edge.project_id
         AND source_object.object_type_id = edge.source_type_id
         AND source_object.primary_id = edge.source_id
      `

  return {
    sql: `
      SELECT DISTINCT
        ${outputAlias}.project_id,
        ${outputAlias}.object_type_id,
        ${outputAlias}.primary_id,
        ${outputAlias}.properties
      FROM (${input.sql}) AS input
      ${joinSql}
    `,
    args: [
      ...input.args,
      linkId,
      ...(sourceObjectTypeId === undefined ? [] : [sourceObjectTypeId]),
    ],
  }
}

function compileAggregateSet(
  projectId: string,
  op: ObjectQuerySetOperation,
  inputs: readonly ObjectQuery[]
): CompiledAggregateSource {
  if (inputs.length === 0) {
    return {
      sql: `
        SELECT project_id, object_type_id, primary_id, properties
        FROM objects
        WHERE 1 = 0
      `,
      args: [],
    }
  }

  const compiledInputs = inputs.map((input) => compileAggregateSource(projectId, input))
  const identities = compileSetIdentities(op, compiledInputs)
  return {
    sql: `
      SELECT selected.project_id, selected.object_type_id, selected.primary_id, selected.properties
      FROM (${identities.sql}) AS ids
      JOIN objects AS selected
        ON selected.project_id = ?
       AND selected.object_type_id = ids.object_type_id
       AND selected.primary_id = ids.primary_id
    `,
    args: [...identities.args, projectId],
  }
}

function compileRowQueryAggregateSource(
  projectId: string,
  query: ObjectQuery
): CompiledAggregateSource {
  const rowQuery = compileObjectQueryInternal(projectId, query, exactContext)
  return {
    sql: `
      SELECT input.project_id, input.object_type_id, input.primary_id, input.properties
      FROM (${rowQuery.sql}) AS input
    `,
    args: rowQuery.args,
  }
}

function needsLimitProbe(query: ObjectQuery): boolean {
  switch (query.kind) {
    case "limit":
      return true
    case "project":
    case "sort":
      return needsLimitProbe(query.input)
    default:
      return false
  }
}

function hasMoreProbeFor(compiled: CompiledPgObjectQuery): CompiledHasMoreProbe {
  return (
    compiled.hasMoreProbe ?? {
      sql: compiled.sql,
      args: compiled.args,
      hasMore: (rowCount) => compiled.hasMore(rowCount, undefined),
    }
  )
}

function compileSetIdentities(
  op: ObjectQuerySetOperation,
  inputs: readonly { sql: string; args: readonly unknown[] }[]
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
      return predicate.scalarKind === "decimal"
        ? compileDecimalEqualityPredicate(predicate.propertyId, "eq", predicate.value)
        : compileEqualityPredicate(predicate.propertyId, "eq", predicate.value)
    case "neq":
      return predicate.scalarKind === "decimal"
        ? compileDecimalEqualityPredicate(predicate.propertyId, "neq", predicate.value)
        : compileEqualityPredicate(predicate.propertyId, "neq", predicate.value)
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const op = sqlComparisonOperator(predicate.op)
      if (predicate.scalarKind === "decimal") {
        return {
          sql: `(${jsonTypeExpression()} = 'string' AND (${jsonTextExpression()})::numeric ${op} ?::numeric)`,
          args: [predicate.propertyId, predicate.propertyId, predicate.value],
        }
      }
      return {
        sql: `${jsonValueExpression()} ${op} ?::text::jsonb`,
        args: [predicate.propertyId, jsonbValue(predicate.value)],
      }
    }
    case "in":
      return predicate.scalarKind === "decimal"
        ? compileDecimalInPredicate(predicate.propertyId, predicate.values)
        : compileInPredicate(predicate.propertyId, predicate.values)
    case "exists": {
      const sql = `jsonb_exists(properties, ?::text)`
      const item: CompiledPredicate = { sql, args: [predicate.propertyId] }
      return predicate.value ? item : negatePredicate(item)
    }
    case "contains":
      return compileContainsPredicate(predicate.propertyId, predicate.value)
  }
}

function compileDecimalEqualityPredicate(
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
      sql: `(${jsonTypeExpression()} = 'string' AND (${jsonTextExpression()})::numeric = ?::numeric)`,
      args: [propertyId, propertyId, value],
    }
  }

  return {
    sql: `(${jsonTypeExpression()} IS NULL OR ${jsonTypeExpression()} = 'null' OR ${jsonTypeExpression()} <> 'string' OR (${jsonTextExpression()})::numeric <> ?::numeric)`,
    args: [propertyId, propertyId, propertyId, propertyId, value],
  }
}

function compileDecimalInPredicate(
  propertyId: string,
  values: readonly unknown[]
): CompiledPredicate {
  if (values.length === 0) return { sql: "0 = 1", args: [] }
  const nonNullValues = values.filter((value) => value !== null)
  const clauses: string[] = []
  const args: unknown[] = []

  if (nonNullValues.length !== values.length) {
    clauses.push(`${jsonTypeExpression()} = 'null'`)
    args.push(propertyId)
  }

  if (nonNullValues.length > 0) {
    clauses.push(
      `(${jsonTypeExpression()} = 'string' AND (${jsonTextExpression()})::numeric IN (${nonNullValues
        .map(() => "?::numeric")
        .join(", ")}))`
    )
    args.push(propertyId, propertyId, ...nonNullValues)
  }

  return {
    sql: `(${clauses.join(" OR ")})`,
    args,
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

  if (typeof value === "string") {
    if (op === "eq") {
      return {
        sql: `(${jsonTypeExpression()} = 'string' AND ${jsonTextExpression()} = ?::text)`,
        args: [propertyId, propertyId, value],
      }
    }

    return {
      sql: `(${jsonTypeExpression()} IS NULL OR ${jsonTypeExpression()} = 'null' OR ${jsonTypeExpression()} <> 'string' OR ${jsonTextExpression()} <> ?::text)`,
      args: [propertyId, propertyId, propertyId, propertyId, value],
    }
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
  const stringValues = nonNullValues.filter((value): value is string => typeof value === "string")
  const jsonbValues = nonNullValues.filter((value) => typeof value !== "string")
  const clauses: string[] = []
  const args: unknown[] = []

  if (values.length !== nonNullValues.length) {
    clauses.push(`${jsonTypeExpression()} = 'null'`)
    args.push(propertyId)
  }

  if (stringValues.length > 0) {
    clauses.push(
      `(${jsonTypeExpression()} = 'string' AND ${jsonTextExpression()} IN (${stringValues
        .map(() => "?::text")
        .join(", ")}))`
    )
    args.push(propertyId, propertyId, ...stringValues)
  }

  if (jsonbValues.length > 0) {
    clauses.push(
      `${jsonValueExpression()} IN (${jsonbValues.map(() => "?::text::jsonb").join(", ")})`
    )
    args.push(propertyId, ...jsonbValues.map(jsonbValue))
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

function compileTextSearchPredicate(
  query: string,
  fields: readonly string[] | undefined,
  fieldsByObjectType: Readonly<Record<string, readonly string[]>> | undefined
): CompiledPredicate {
  const predicate =
    fields && fields.length > 0
      ? compileTextPredicate(query, fields)
      : compileScopedTextPredicate(query, fieldsByObjectType)

  if (!predicate) {
    throw new Error(
      "[SixbPg] PostgreSQL object text search requires fields or resolved text defaults"
    )
  }

  return predicate
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
      `${compiledPropertyValueExpression(field, propertyColumn)} ${direction}`
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
      scalarKind: field.scalarKind,
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
    sql: `(${jsonTypeExpression(propertyColumn)} IS NOT NULL AND ${jsonTypeExpression(propertyColumn)} != 'null' AND ${compiledPropertyValueExpression(field, propertyColumn)} = ${field.scalarKind === "decimal" ? "?::numeric" : "?::text::jsonb"})`,
    args: [
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.scalarKind === "decimal" ? cursor.value : jsonbValue(cursor.value),
    ],
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
    sql: `(${rankSql} > 0 OR (${rankSql} = 0 AND ${compiledPropertyValueExpression(field, propertyColumn)} ${valueOperator} ${field.scalarKind === "decimal" ? "?::numeric" : "?::text::jsonb"}))`,
    args: [
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.propertyId,
      field.scalarKind === "decimal" ? cursor.value : jsonbValue(cursor.value),
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
  throw objectQueryExecutionFailed(
    "storage.query_invalid",
    "invalid_page_token",
    message,
    "$.pageToken"
  )
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
    : `property:${field.propertyId}:${field.scalarKind ?? "json"}:${field.direction}`
}

function compiledPropertyValueExpression(
  field: Extract<CompiledOrderField, { kind: "property" }>,
  propertyColumn = "properties"
): string {
  return field.scalarKind === "decimal"
    ? `(${jsonTextExpression(propertyColumn)})::numeric`
    : jsonValueExpression(propertyColumn)
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

function numberCompiledQuery<T extends { sql: string; args: unknown[] }>(compiled: T): T {
  return {
    ...compiled,
    sql: numberPlaceholders(compiled.sql),
  }
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
