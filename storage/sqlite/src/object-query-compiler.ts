import {
  type ObjectExpansion,
  type ObjectQuery,
  ObjectQueryExecutionError,
  type ObjectQueryPredicate,
  type ObjectQuerySetOperation,
  type ObjectQuerySortField,
} from "@sixb/core"

export type SqliteValue = string | number | bigint | boolean | null

export interface SqliteObjectQueryPageRow {
  object_type_id: string
  primary_id: string
  properties: string
  _cursor_properties?: string
}

export interface CompiledObjectQuery {
  sql: string
  args: SqliteValue[]
  totalSql: string
  totalArgs: SqliteValue[]
  order: CompiledOrder
  hasMoreProbe?: CompiledHasMoreProbe
  hasMore(rowCount: number, total?: number): boolean
  trimRows<T>(rows: readonly T[]): readonly T[]
  nextPageToken(rows: readonly SqliteObjectQueryPageRow[], rowCount: number): string | undefined
}

interface CompiledHasMoreProbe {
  sql: string
  args: SqliteValue[]
  hasMore(rowCount: number): boolean
}

interface CompileContext {
  probeLimit: boolean
  source: SqliteObjectQuerySource
}

interface CompiledPredicate {
  sql: string
  args: SqliteValue[]
}

interface CompiledOrder {
  sql: string
  args: SqliteValue[]
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

// Fallback fanout cap for a "many" expansion that arrives without an explicit
// limit. The core executor normally bakes a limit in before pushdown; this only
// bounds the degenerate uncapped case. Mirrors the PostgreSQL compiler.
const DEFAULT_EXPANSION_FANOUT = 1_000

export function compileObjectQuery(
  projectId: string,
  query: ObjectQuery,
  options: { includeTotal?: boolean; source?: SqliteObjectQuerySource } = {}
): CompiledObjectQuery {
  const source = options.source ?? DEFAULT_OBJECT_QUERY_SOURCE
  const ctx: CompileContext = { probeLimit: options.includeTotal === false, source }
  return source.wrapQuery(compileObjectQueryInternal(projectId, query, ctx))
}

/** Physical relations used by the object-query compiler. */
export interface SqliteObjectQuerySource {
  readonly objectsTable: string
  readonly linksTable: string
  /** Wrap a terminal SELECT without its own WITH clause; the selected source owns the only WITH. */
  wrapStatement(
    sql: string,
    args?: readonly SqliteValue[]
  ): {
    readonly sql: string
    readonly args: readonly SqliteValue[]
  }
  wrapQuery(query: CompiledObjectQuery): CompiledObjectQuery
}

const DEFAULT_OBJECT_QUERY_SOURCE: SqliteObjectQuerySource = {
  objectsTable: "objects",
  linksTable: "links",
  wrapStatement: (sql, args = []) => ({ sql, args: [...args] }),
  wrapQuery: (query) => query,
}

function exactContext(ctx: CompileContext): CompileContext {
  return ctx.probeLimit ? { ...ctx, probeLimit: false } : ctx
}

function compileObjectQueryInternal(
  projectId: string,
  query: ObjectQuery,
  ctx: CompileContext
): CompiledObjectQuery {
  switch (query.kind) {
    case "start":
      return compileStart(projectId, query, ctx)
    case "refs":
      return compileRefs(projectId, query, ctx)
    case "filter":
      return compileFilter(projectId, query.input, query.predicate, ctx)
    case "sort":
      return compileSort(projectId, query.input, query.fields, ctx)
    case "limit":
      return compileLimit(projectId, query.input, query.limit, ctx)
    case "page":
      return compilePage(projectId, query.input, query.pageSize, query.pageToken, ctx)
    case "traverse":
      return compileTraversal(
        projectId,
        query.input,
        query.linkId,
        query.direction,
        query.sourceObjectTypeId,
        ctx
      )
    case "set":
      return compileSet(projectId, query.op, query.inputs, ctx)
    case "project":
      return compileProject(projectId, query.input, query.properties, ctx)
    case "text":
      return compileText(
        projectId,
        query.input,
        query.query,
        query.fields,
        query.fieldsByObjectType,
        ctx
      )
    case "expand":
      return compileExpand(projectId, query.input, query.expansions, ctx)
    case "vector":
      throw new Error(`[Sixb] SQLite object storage does not support query node '${query.kind}'`)
  }
}

function compileStart(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "start" }>,
  ctx: CompileContext
): CompiledObjectQuery {
  if (query.includeSubtypes === true) {
    throw new Error("[Sixb] SQLite object storage does not support start.includeSubtypes")
  }

  const order = compileOrder(identityOrderFields())
  const sql = `
    SELECT *, properties AS _cursor_properties
    FROM ${ctx.source.objectsTable}
    WHERE project_id = ? AND object_type_id = ?
    ORDER BY ${order.sql}
  `
  const args = [projectId, query.objectTypeId, ...order.args]

  return {
    sql,
    args,
    totalSql: `SELECT COUNT(*) as total FROM ${ctx.source.objectsTable} WHERE project_id = ? AND object_type_id = ?`,
    totalArgs: [projectId, query.objectTypeId],
    order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileRefs(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "refs" }>,
  ctx: CompileContext
): CompiledObjectQuery {
  if (query.refs.length === 0) {
    throw new Error("[Sixb] SQLite object storage requires at least one ref")
  }

  const order = compileOrder(identityOrderFields())
  const selectedOrder = compileOrder(identityOrderFields(), "selected")
  const refsJson = JSON.stringify(query.refs)
  const requested = `
    SELECT DISTINCT
      json_extract(ref.value, '$.objectTypeId') AS object_type_id,
      json_extract(ref.value, '$.primaryId') AS primary_id
    FROM json_each(?) AS ref
  `
  const sql = `
    SELECT selected.*, selected.properties AS _cursor_properties
    FROM (${requested}) AS requested
    JOIN ${ctx.source.objectsTable} AS selected
      ON selected.project_id = ?
     AND selected.object_type_id = requested.object_type_id
     AND selected.primary_id = requested.primary_id
    ORDER BY ${selectedOrder.sql}
  `

  return {
    sql,
    args: [refsJson, projectId, ...selectedOrder.args],
    totalSql: `
      SELECT COUNT(*) AS total
      FROM (${requested}) AS requested
      JOIN ${ctx.source.objectsTable} AS selected
        ON selected.project_id = ?
       AND selected.object_type_id = requested.object_type_id
       AND selected.primary_id = requested.primary_id
    `,
    totalArgs: [refsJson, projectId],
    order,
    hasMore: () => false,
    trimRows: identityRows,
    nextPageToken: () => undefined,
  }
}

function compileFilter(
  projectId: string,
  inputQuery: ObjectQuery,
  predicateNode: ObjectQueryPredicate,
  ctx: CompileContext
): CompiledObjectQuery {
  const predicate = compilePredicate(predicateNode)
  return compileWhere(projectId, inputQuery, predicate, ctx)
}

function compileWhere(
  projectId: string,
  inputQuery: ObjectQuery,
  predicate: CompiledPredicate,
  ctx: CompileContext
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
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
      SELECT COUNT(*) as total
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
  fieldsByObjectType: Readonly<Record<string, readonly string[]>> | undefined,
  ctx: CompileContext
): CompiledObjectQuery {
  const predicate =
    fields && fields.length > 0
      ? compileTextPredicate(query, fields)
      : compileScopedTextPredicate(query, fieldsByObjectType)

  if (!predicate) {
    throw new Error("[Sixb] SQLite object text search requires fields or resolved text defaults")
  }
  return compileWhere(projectId, inputQuery, predicate, ctx)
}

function compileSort(
  projectId: string,
  inputQuery: ObjectQuery,
  fields: readonly ObjectQuerySortField[],
  ctx: CompileContext
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
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
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
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
      SELECT COUNT(*) as total
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
  pageToken: string | undefined,
  ctx: CompileContext
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
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
      SELECT COUNT(*) as total
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
  sourceObjectTypeId: string | undefined,
  ctx: CompileContext
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
  const outputAlias = direction === "outgoing" ? "target_object" : "source_object"
  const joinSql =
    direction === "outgoing"
      ? `
        JOIN ${ctx.source.linksTable} AS edge
          ON edge.project_id = input.project_id
         AND edge.source_type_id = input.object_type_id
         AND edge.source_id = input.primary_id
         AND edge.link_id = ?
        JOIN ${ctx.source.objectsTable} AS target_object
          ON target_object.project_id = edge.project_id
         AND target_object.object_type_id = edge.target_type_id
         AND target_object.primary_id = edge.target_id
      `
      : `
        JOIN ${ctx.source.linksTable} AS edge
          ON edge.project_id = input.project_id
         AND edge.target_type_id = input.object_type_id
         AND edge.target_id = input.primary_id
         AND edge.link_id = ?${sourceObjectTypeId === undefined ? "" : "\n         AND edge.source_type_id = ?"}
        JOIN ${ctx.source.objectsTable} AS source_object
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
    totalSql: `SELECT COUNT(*) as total FROM (${sql}) AS traversed`,
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
// becomes a correlated subquery that hydrates its links into a JSON value, and
// all expansions are folded into one `_expand` object column the row mapper reads
// back. The input set is otherwise untouched, so pagination/order pass through.
function compileExpand(
  projectId: string,
  inputQuery: ObjectQuery,
  expansions: readonly ObjectExpansion[],
  ctx: CompileContext
): CompiledObjectQuery {
  const input = compileObjectQueryInternal(projectId, inputQuery, exactContext(ctx))
  const expand = compileExpansionsObject(
    expansions,
    { project: "input.project_id", type: "input.object_type_id", id: "input.primary_id" },
    "",
    ctx
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

// `json_object(linkId, value, ...)` over a set of expansions sharing one parent.
// Link ids are user data, so they ride as parameters. Each value is a correlated
// subquery whose JSON subtype is lost crossing the subquery boundary, so it is
// re-parsed with `json(...)` to embed as nested JSON rather than a quoted string.
// Used both for the outer `_expand` column and for each child's nested `links`.
function compileExpansionsObject(
  expansions: readonly ObjectExpansion[],
  parent: ExpansionParent,
  pathPrefix: string,
  ctx: CompileContext
): CompiledPredicate {
  const parts: string[] = []
  const args: SqliteValue[] = []
  expansions.forEach((expansion, index) => {
    const path = pathPrefix === "" ? `${index}` : `${pathPrefix}_${index}`
    const value = compileExpansionValue(expansion, parent, path, ctx)
    parts.push("?", `json(${value.sql})`)
    args.push(expansion.linkId, ...value.args)
  })
  return { sql: `json_object(${parts.join(", ")})`, args }
}

// One expansion's hydrated value. `row_number()` numbers a parent's links by the
// order from `compileExpansionOrder` (the expansion's `orderBy` against the target
// object's properties, then an identity tiebreak); `WHERE _ord <= N` keeps the
// top-N per parent in-DB; each retained neighbour becomes a JSON object; and the
// value is an ordered array ("many") or the first element or null ("one"). The
// cardinality is core-resolved before pushdown.
function compileExpansionValue(
  expansion: ObjectExpansion,
  parent: ExpansionParent,
  path: string,
  ctx: CompileContext
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

  const child = compileExpansionChildJson(expansion, edge, target, path, ctx)
  const order = compileExpansionOrder(expansion, target, neighborType, neighborId)

  const whereParts = [
    `${edge}.project_id = ${parent.project}`,
    `${parentType} = ${parent.type}`,
    `${parentId} = ${parent.id}`,
    `${edge}.link_id = ?`,
  ]
  const whereArgs: SqliteValue[] = [expansion.linkId]
  if (incoming && expansion.sourceObjectTypeId !== undefined) {
    whereParts.push(`${edge}.source_type_id = ?`)
    whereArgs.push(expansion.sourceObjectTypeId)
  }

  const inner = `
    SELECT ${child.sql} AS elem, row_number() OVER (ORDER BY ${order.sql}) AS _ord
    FROM ${ctx.source.linksTable} AS ${edge}
    JOIN ${ctx.source.objectsTable} AS ${target}
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
  // Each element is re-parsed with `json(...)` so the aggregate embeds objects
  // rather than the quoted JSON text the subquery column hands back.
  const limit = expansion.limit ?? DEFAULT_EXPANSION_FANOUT
  return {
    sql: `COALESCE((SELECT json_group_array(json(${ranked}.elem) ORDER BY ${ranked}._ord) FROM (${inner}) AS ${ranked} WHERE ${ranked}._ord <= ?), '[]')`,
    args: [...innerArgs, limit],
  }
}

// Build one hydrated neighbour as an `ExpandedObjectRow`-shaped JSON object. The
// JSON-valued columns (`properties`, the edge's `linkProperties`) are re-parsed
// with `json(...)` so they embed as JSON rather than strings; `linkProperties`
// always rides along (the mapper drops it when null/empty), and nested expansions
// recurse under `links`, correlated on this neighbour.
function compileExpansionChildJson(
  expansion: ObjectExpansion,
  edge: string,
  target: string,
  path: string,
  ctx: CompileContext
): CompiledPredicate {
  const fields = [
    `'projectId', ${target}.project_id`,
    `'objectTypeId', ${target}.object_type_id`,
    `'primaryId', ${target}.primary_id`,
    `'properties', json(${target}.properties)`,
    `'createdAt', ${target}.created_at`,
    `'updatedAt', ${target}.updated_at`,
    `'version', ${target}.version`,
    `'lastCommitId', ${target}.last_commit_id`,
    `'linkProperties', json(${edge}.properties)`,
  ]
  const args: SqliteValue[] = []

  if (expansion.expand && expansion.expand.length > 0) {
    const nested = compileExpansionsObject(
      expansion.expand,
      {
        project: `${target}.project_id`,
        type: `${target}.object_type_id`,
        id: `${target}.primary_id`,
      },
      path,
      ctx
    )
    fields.push(`'links', ${nested.sql}`)
    args.push(...nested.args)
  }

  return { sql: `json_object(${fields.join(", ")})`, args }
}

// Order a parent's links the way the fallback's per-parent trim does: each
// property sorts nulls last with the requested direction (against the neighbour's
// JSON properties), then a deterministic identity tiebreak on the neighbour.
function compileExpansionOrder(
  expansion: ObjectExpansion,
  target: string,
  neighborType: string,
  neighborId: string
): CompiledPredicate {
  const propertyColumn = `${target}.properties`
  const clauses: string[] = []
  const args: SqliteValue[] = []

  for (const field of expansion.orderBy ?? []) {
    // Relevance is a no-op in the fallback comparator; mirror that by skipping it.
    if (field.kind !== "property") continue
    if (field.scalarKind === "decimal") {
      throw new ObjectQueryExecutionError(
        "exact_decimal_not_supported",
        "SQLite object storage cannot push down exact decimal expansion sorting",
        "$.expand.orderBy"
      )
    }
    const direction = field.direction === "desc" ? "DESC" : "ASC"
    const path = jsonPath(field.propertyId)
    clauses.push(
      `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END ASC`,
      `${jsonValueExpression(propertyColumn)} ${direction}`
    )
    args.push(path, path, path)
  }

  clauses.push(`${neighborType} ASC`, `${neighborId} ASC`)
  return { sql: clauses.join(", "), args }
}

function compileSet(
  projectId: string,
  op: ObjectQuerySetOperation,
  inputs: readonly ObjectQuery[],
  ctx: CompileContext
): CompiledObjectQuery {
  if (inputs.length === 0) {
    const order = compileOrder(identityOrderFields())
    return {
      sql: `
        SELECT *
        FROM ${ctx.source.objectsTable}
        WHERE 1 = 0
        ORDER BY ${order.sql}
      `,
      args: order.args,
      totalSql: "SELECT 0 as total",
      totalArgs: [],
      order,
      hasMore: () => false,
      trimRows: identityRows,
      nextPageToken: () => undefined,
    }
  }

  const compiledInputs = inputs.map((input) =>
    compileObjectQueryInternal(projectId, input, exactContext(ctx))
  )
  const identities = compileSetIdentities(op, compiledInputs)
  const order = compileOrder(identityOrderFields())
  const selectedOrder = compileOrder(identityOrderFields(), "selected")
  const sql = `
    SELECT selected.*, selected.properties AS _cursor_properties
    FROM (${identities.sql}) AS ids
    JOIN ${ctx.source.objectsTable} AS selected
      ON selected.project_id = ?
     AND selected.object_type_id = ids.object_type_id
     AND selected.primary_id = ids.primary_id
    ORDER BY ${selectedOrder.sql}
  `
  const args = [...identities.args, projectId, ...selectedOrder.args]

  return {
    sql,
    args,
    totalSql: `SELECT COUNT(*) as total FROM (${identities.sql}) AS ids`,
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
): CompiledObjectQuery {
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

function hasMoreProbeFor(compiled: CompiledObjectQuery): CompiledHasMoreProbe {
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
  inputs: readonly CompiledObjectQuery[]
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
  if (properties.length === 0) return { sql: "json('{}')", args: [] }

  return {
    sql: `
      COALESCE(
        (
          SELECT json_group_object(projected.key, ${sqliteJsonEachValue("projected")})
          FROM json_each(input.properties) AS projected
          WHERE projected.key IN (${properties.map(() => "?").join(", ")})
        ),
        json('{}')
      )
    `,
    args: [...properties],
  }
}

/** json_each exposes JSON booleans as integer SQL values; restore their JSON representation. */
export function sqliteJsonEachValue(alias: string): string {
  return `CASE ${alias}.type
    WHEN 'true' THEN json('true')
    WHEN 'false' THEN json('false')
    ELSE ${alias}.value
  END`
}

function compilePredicate(predicate: ObjectQueryPredicate): CompiledPredicate {
  if (
    "scalarKind" in predicate &&
    predicate.scalarKind === "decimal" &&
    (predicate.op === "lt" ||
      predicate.op === "lte" ||
      predicate.op === "gt" ||
      predicate.op === "gte")
  ) {
    throw new ObjectQueryExecutionError(
      "exact_decimal_not_supported",
      "SQLite object storage cannot push down exact decimal predicates",
      "$.predicate"
    )
  }

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
        sql: `${jsonValueExpression()} ${op} ?`,
        args: [jsonPath(predicate.propertyId), sqlValue(predicate.value)],
      }
    }
    case "in":
      return compileInPredicate(predicate.propertyId, predicate.values)
    case "exists": {
      const sql = `${jsonTypeExpression()} IS NOT NULL`
      const item: CompiledPredicate = { sql, args: [jsonPath(predicate.propertyId)] }
      return predicate.value ? item : negatePredicate(item)
    }
    case "contains":
      return compileContainsPredicate(predicate.propertyId, predicate.value)
  }
}

function negatePredicate(predicate: CompiledPredicate): CompiledPredicate {
  return {
    sql: `(NOT COALESCE((${predicate.sql}), 0))`,
    args: predicate.args,
  }
}

function compileEqualityPredicate(
  propertyId: string,
  op: "eq" | "neq",
  value: unknown
): CompiledPredicate {
  const path = jsonPath(propertyId)
  if (value === null) {
    const sql = `${jsonTypeExpression()} = 'null'`
    const item: CompiledPredicate = { sql, args: [path] }
    return op === "eq" ? item : negatePredicate(item)
  }

  if (op === "eq") {
    return {
      sql: `${jsonValueExpression()} = ?`,
      args: [path, sqlValue(value)],
    }
  }

  // JS predicate semantics treat missing/null properties as not equal to any
  // non-null scalar. SQL three-valued null logic needs those cases explicit.
  return {
    sql: `(${jsonTypeExpression()} IS NULL OR ${jsonTypeExpression()} = 'null' OR ${jsonValueExpression()} != ?)`,
    args: [path, path, path, sqlValue(value)],
  }
}

function compileInPredicate(propertyId: string, values: readonly unknown[]): CompiledPredicate {
  if (values.length === 0) return { sql: "0 = 1", args: [] }

  const path = jsonPath(propertyId)
  const nonNullValues = values.filter((value) => value !== null)
  const clauses: string[] = []
  const args: SqliteValue[] = []

  if (values.length !== nonNullValues.length) {
    clauses.push(`${jsonTypeExpression()} = 'null'`)
    args.push(path)
  }

  if (nonNullValues.length > 0) {
    clauses.push(`${jsonValueExpression()} IN (${nonNullValues.map(() => "?").join(", ")})`)
    args.push(path, ...nonNullValues.map(sqlValue))
  }

  return {
    sql: `(${clauses.join(" OR ")})`,
    args,
  }
}

function compileContainsPredicate(propertyId: string, value: unknown): CompiledPredicate {
  const path = jsonPath(propertyId)
  const clauses: string[] = []
  const args: SqliteValue[] = []

  if (typeof value === "string") {
    clauses.push(`(${jsonTypeExpression()} = 'text' AND instr(${jsonValueExpression()}, ?) > 0)`)
    args.push(path, path, value)
  }

  clauses.push(
    `(${jsonTypeExpression()} = 'array' AND EXISTS (SELECT 1 FROM json_each(properties, ?) AS item WHERE item.value IS ?))`
  )
  args.push(path, path, sqlValue(value))

  if (typeof value === "string") {
    clauses.push(
      `(${jsonTypeExpression()} = 'object' AND EXISTS (SELECT 1 FROM json_each(properties, ?) AS item WHERE item.key = ?))`
    )
    args.push(path, path, value)
  }

  return { sql: `(${clauses.join(" OR ")})`, args }
}

function compileTextPredicate(query: string, fields: readonly string[]): CompiledPredicate {
  const terms = tokenize(query)
  if (terms.length === 0) return { sql: "0 = 1", args: [] }

  const clauses = terms.map(() => {
    const fieldClauses = fields.map(
      () => `instr(lower(COALESCE(CAST(${jsonValueExpression()} AS TEXT), '')), ?) > 0`
    )
    return `(${fieldClauses.join(" OR ")})`
  })
  const args = terms.flatMap((term) => fields.flatMap((field) => [jsonPath(field), term]))

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
  const args: SqliteValue[] = []

  for (const field of fields) {
    if (field.kind === "column") {
      clauses.push(`${columnExpression(field.column, qualifier)} ${field.direction.toUpperCase()}`)
      continue
    }

    const direction = field.direction === "desc" ? "DESC" : "ASC"
    const path = jsonPath(field.propertyId)
    clauses.push(
      `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END ASC`,
      `${jsonValueExpression(propertyColumn)} ${direction}`
    )
    args.push(path, path, path)
  }

  return { sql: clauses.join(", "), args, fields, propertyColumn }
}

function sortOrderFields(fields: readonly ObjectQuerySortField[]): readonly CompiledOrderField[] {
  const orderFields: CompiledOrderField[] = []
  for (const field of fields) {
    if (field.kind !== "property") {
      throw new Error("[Sixb] SQLite object storage does not support relevance sorting")
    }
    if (field.scalarKind === "decimal") {
      throw new ObjectQueryExecutionError(
        "exact_decimal_not_supported",
        "SQLite object storage cannot push down exact decimal sorting",
        "$.sort"
      )
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
      args: [sqlValue(cursor.value)],
    }
  }

  const path = jsonPath(field.propertyId)
  if (cursor.nullish) {
    return {
      sql: `(${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null')`,
      args: [path, path],
    }
  }

  return {
    sql: `(${jsonTypeExpression(propertyColumn)} IS NOT NULL AND ${jsonTypeExpression(propertyColumn)} != 'null' AND ${jsonValueExpression(propertyColumn)} = ?)`,
    args: [path, path, path, sqlValue(cursor.value)],
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
      args: [sqlValue(cursor.value)],
    }
  }

  if (cursor.nullish) return null

  const path = jsonPath(field.propertyId)
  const rankSql = `CASE WHEN ${jsonTypeExpression(propertyColumn)} IS NULL OR ${jsonTypeExpression(propertyColumn)} = 'null' THEN 1 ELSE 0 END`
  const valueOperator = field.direction === "desc" ? "<" : ">"

  return {
    sql: `(${rankSql} > 0 OR (${rankSql} = 0 AND ${jsonValueExpression(propertyColumn)} ${valueOperator} ?))`,
    args: [path, path, path, path, path, sqlValue(cursor.value)],
  }
}

function encodePageToken(
  row: SqliteObjectQueryPageRow,
  fields: readonly CompiledOrderField[]
): string {
  const properties = JSON.parse(row._cursor_properties ?? row.properties) as Record<string, unknown>
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
    throwInvalidPageToken("Invalid SQLite object query page token")
  }

  const raw = token.slice(PAGE_TOKEN_PREFIX.length)
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throwInvalidPageToken("Invalid SQLite object query page token")
  }

  if (!isEncodedPageToken(decoded)) {
    throwInvalidPageToken("Invalid SQLite object query page token")
  }

  const expectedOrder = fields.map(orderFieldKey)
  if (
    decoded.order.length !== expectedOrder.length ||
    decoded.order.some((field, index) => field !== expectedOrder[index])
  ) {
    throwInvalidPageToken("SQLite object query page token does not match query order")
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
  row: SqliteObjectQueryPageRow,
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
  return `json_extract(${column}, ?)`
}

function jsonTypeExpression(column = "properties"): string {
  return `json_type(${column}, ?)`
}

function jsonPath(propertyId: string): string {
  return `$."${propertyId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function sqlValue(value: unknown): SqliteValue {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "boolean") return value ? 1 : 0
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value === null
  ) {
    return value
  }
  return JSON.stringify(value)
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

function identityRows<T>(rows: readonly T[]): readonly T[] {
  return rows
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
