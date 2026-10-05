import { createHash } from "node:crypto"
import type { ObjectQuery, ObjectQueryPredicate } from "@sixb/core"
import type { ReservedSQL, SQL, SQLClient } from "../pg-client"
import { isConnectionLost } from "../storage-errors"
import { withReservedPgConnection } from "../transactions"
import { lockPgPreparation } from "./preparation-lock"
import {
  compilePgFacetSummary,
  compilePgObjectCountQuery,
  compilePgObjectQuery,
  DEFAULT_OBJECT_QUERY_SOURCE,
} from "./query-compiler"

export interface PgObjectTextCountIndex {
  readonly projectId: string
  readonly objectTypeId: string
  readonly propertyId: string
  /** Up to four string equality filters used with this text search. */
  readonly filters?: readonly string[]
}

function describe(input: PgObjectTextCountIndex) {
  const definition = { ...input, filters: [...new Set(input.filters ?? [])].sort() }
  if (definition.filters.length > 4)
    throw new Error("[SixbPg] Text counts support at most four string filters")
  for (const value of [
    input.projectId,
    input.objectTypeId,
    input.propertyId,
    ...definition.filters,
  ])
    literal(value)
  const key = hash(
    JSON.stringify([
      definition.projectId,
      definition.objectTypeId,
      definition.propertyId,
      definition.filters,
    ])
  )
  const textColumn = `sixb_qtext_${key}`
  const filters = new Map(
    definition.filters.map((property) => [
      property,
      `sixb_qfilter_${hash(JSON.stringify([input.projectId, input.objectTypeId, property]))}`,
    ])
  )
  const scope = `project_id = ${literal(input.projectId)} AND object_type_id = ${literal(input.objectTypeId)}`
  // Bound B-tree entry size without restricting application data. Long rows use an exact
  // overflow path; adding this index must never make a later valid object write fail.
  const compact = [
    `octet_length(${identifier(textColumn)}) <= 1024`,
    ...[...filters.values()].map(
      (column) => `(${identifier(column)} IS NULL OR octet_length(${identifier(column)}) <= 128)`
    ),
  ].join(" AND ")
  return { definition, name: `sixb_text_count_${key}`, textColumn, filters, scope, compact }
}

/** Explicit offline preparation: adding STORED generated columns rewrites existing objects. */
export async function preparePgObjectTextCounts(
  sql: SQL | ReservedSQL,
  schema: string,
  inputs: readonly PgObjectTextCountIndex[]
): Promise<readonly string[]> {
  const definitions = inputs.map(describe)
  if (!definitions.length) return []

  const [extension] = await sql<{ ready: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
    ) AS ready
  `
  if (!extension?.ready)
    throw new Error("[SixbPg] Text counts require CREATE EXTENSION pg_trgm WITH SCHEMA public")
  const table = `${identifier(schema)}.objects`
  const names: string[] = []
  await withReservedPgConnection(sql, async (connection) => {
    let connected = true
    try {
      await lockPgPreparation(connection, `${schema}.objects.query-indexes`)

      const existing = await connection<{ attname: string }[]>`
        SELECT attname FROM pg_attribute
        WHERE attrelid = ${table}::regclass AND attnum > 0 AND NOT attisdropped
      `
      const columns = new Set(existing.map((row) => row.attname))
      const additions = new Map<string, string>()
      for (const item of definitions) {
        additions.set(
          item.textColumn,
          `CASE WHEN ${item.scope} THEN lower(coalesce(properties ->> ${literal(item.definition.propertyId)}, '')) END`
        )
        for (const [property, column] of item.filters)
          additions.set(
            column,
            `CASE WHEN ${item.scope} AND jsonb_typeof(properties -> ${literal(property)}) = 'string' THEN properties ->> ${literal(property)} END`
          )
      }

      const missing = [...additions].filter(([column]) => !columns.has(column))
      if (missing.length > 0) {
        await connection.unsafe(
          `ALTER TABLE ${table} ${missing.map(([column, expression]) => `ADD COLUMN ${identifier(column)} text GENERATED ALWAYS AS (${expression}) STORED`).join(", ")}`
        )
      }

      for (const item of definitions) {
        const statements = textCountIndexStatements(item)
        for (const [name, expression] of statements) {
          await connection.unsafe(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${identifier(name)} ON ${table} ${expression}`
          )
          const [valid] = await connection<{ indisvalid: boolean }[]>`
            SELECT indisvalid FROM pg_index
            WHERE indexrelid = ${`${identifier(schema)}.${identifier(name)}`}::regclass
          `
          if (!valid?.indisvalid)
            throw new Error(
              `[SixbPg] Text count index ${schema}.${name} is invalid. Drop it concurrently and retry preparation.`
            )
        }
        await connection.unsafe(
          `COMMENT ON INDEX ${identifier(schema)}.${identifier(item.name)} IS ${literal(JSON.stringify(item.definition))}`
        )
        names.push(item.name)
      }
      await connection.unsafe(`ANALYZE ${table}`)
    } catch (error) {
      connected = !isConnectionLost(error)
      throw error
    } finally {
      if (connected)
        await connection`SELECT pg_advisory_unlock(hashtextextended(${`${schema}.objects.query-indexes`}, 0))`
    }
  })
  return names
}

type TextCountDefinition = ReturnType<typeof describe>

/** Cover compact text/filter values; separate overflow indexes preserve unbounded values. */
function textCountIndexStatements(item: TextCountDefinition): [string, string][] {
  const predicate = `${item.scope} AND (${item.compact})`
  const statements: [string, string][] = [
    [
      item.name,
      `(${[...item.filters.values(), item.textColumn].map(identifier).join(", ")}) WHERE ${predicate}`,
    ],
    [
      `${item.name}_gin`,
      `USING gin (${identifier(item.textColumn)} public.gin_trgm_ops) WHERE ${predicate}`,
    ],
    [`${item.name}_overflow`, `(primary_id) WHERE ${item.scope} AND NOT (${item.compact})`],
  ]

  if (item.filters.size > 0) {
    const columns = [...item.filters.values()].map(identifier)
    const compact = columns
      .map((column) => `(${column} IS NOT NULL AND octet_length(${column}) <= 128)`)
      .join(" AND ")
    statements.push(
      [`${item.name}_facets`, `(${columns.join(", ")}) WHERE ${item.scope} AND (${compact})`],
      [`${item.name}_facet_overflow`, `(primary_id) WHERE ${item.scope} AND NOT (${compact})`],
      [
        `${item.name}_text_facets_overflow`,
        `(primary_id) WHERE ${item.scope} AND NOT ((${item.compact}) AND (${columns.map((column) => `${column} IS NOT NULL`).join(" AND ")}))`,
      ]
    )
  }

  return statements
}

/** Narrow optimization for flat counts; unsupported predicates and selected scopes use the normal compiler. */
export async function compilePgIndexedTextCount(
  sql: SQLClient,
  projectId: string,
  query: ObjectQuery
): Promise<{ sql: string; args: unknown[] } | undefined> {
  return compilePgIndexedTextAggregate(sql, projectId, query)
}

export async function compilePgIndexedTextFacets(
  sql: SQLClient,
  projectId: string,
  query: ObjectQuery,
  facets: readonly { propertyId: string; limit: number }[]
): Promise<{ sql: string; args: unknown[] } | undefined> {
  return compilePgIndexedTextAggregate(sql, projectId, query, facets)
}

/** Try compact indexes first, then merge exact results for values outside their size bounds. */
async function compilePgIndexedTextAggregate(
  sql: SQLClient,
  projectId: string,
  query: ObjectQuery,
  facets?: readonly { propertyId: string; limit: number }[]
): Promise<{ sql: string; args: unknown[] } | undefined> {
  const shape = flatCount(query)
  if (!shape || (!shape.text.length && !facets)) return undefined

  const rows = await sql<{ name: string; definition: string }[]>`
    SELECT c.relname AS name, obj_description(c.oid,'pg_class') AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid='objects'::regclass AND i.indisvalid
      AND c.relname LIKE 'sixb_text_count_%' AND obj_description(c.oid,'pg_class') IS NOT NULL`
  for (const row of rows) {
    const definition = parseDefinition(row.definition)
    if (
      !definition ||
      definition.projectId !== projectId ||
      definition.objectTypeId !== shape.objectTypeId
    )
      continue
    const item = describe(definition)
    if (item.name !== row.name) continue
    if (facets?.some((facet) => !item.filters.has(facet.propertyId))) continue
    if (
      shape.text.some((text) => {
        const fields = text.fields?.length
          ? text.fields
          : text.fieldsByObjectType?.[shape.objectTypeId]
        return fields?.length !== 1 || fields[0] !== definition.propertyId
      })
    )
      continue

    const args: unknown[] = []
    const bind = (value: unknown) => {
      args.push(value)
      return `$${args.length}`
    }
    const where = [
      `project_id=${bind(projectId)}`,
      `object_type_id=${bind(shape.objectTypeId)}`,
      `(${item.compact})`,
    ]
    let supported = true
    for (const predicate of shape.predicates) {
      const condition = stringPredicate(predicate, item.filters, bind)
      if (!condition) {
        supported = false
        break
      }
      where.push(condition)
    }
    if (!supported) continue

    const broadWhere = [...where]
    for (const text of shape.text) {
      const terms = text.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (!terms.length) {
        where.push("false")
        broadWhere.push("false")
      }
      for (const term of terms) {
        where.push(
          `${identifier(item.textColumn)} LIKE ${bind(`%${term.replace(/[\\%_]/g, "\\$&")}%`)}::text`
        )
        // POSITION deliberately chooses a covering B-tree scan for broad searches; GIN
        // must fetch/recheck the heap and becomes lossy beyond work_mem.
        broadWhere.push(`position(${bind(term)}::text in ${identifier(item.textColumn)}) > 0`)
      }
    }

    const input = { projectId, query, item, where, broadWhere, args }
    if (facets) return compileIndexedFacets(input, facets, shape.text.length > 0, bind)
    return compileIndexedCount(input)
  }
  return undefined
}

interface IndexedAggregateInput {
  projectId: string
  query: ObjectQuery
  item: TextCountDefinition
  where: string[]
  broadWhere: string[]
  args: unknown[]
}

function compileIndexedFacets(
  { projectId, query, item, where, broadWhere, args }: IndexedAggregateInput,
  facets: readonly { propertyId: string; limit: number }[],
  hasText: boolean,
  bind: (value: unknown) => string
): { sql: string; args: unknown[] } {
  const allString =
    [...item.filters.values()].map((column) => `${identifier(column)} IS NOT NULL`).join(" AND ") ||
    "true"
  const filterCompact =
    [...item.filters.values()]
      .map(
        (column) =>
          `(${identifier(column)} IS NOT NULL AND octet_length(${identifier(column)}) <= 128)`
      )
      .join(" AND ") || "true"
  const compact = hasText ? `(${item.compact}) AND (${allString})` : filterCompact
  // Plain facets do not need to read the text column. Their covering index is tiny.
  const nativeWhere = hasText
    ? [...where, allString]
    : [where[0]!, where[1]!, compact, ...where.slice(3)]
  const nativeBroad = [...broadWhere, allString]
  const fields = facets
    .map(
      (facet, i) =>
        `'string'::text AS f${i}_type, ${identifier(item.filters.get(facet.propertyId)!)} AS f${i}_value`
    )
    .join(", ")

  // Read oversized or non-string values through the general compiler.
  const overflow = compilePgObjectQuery(projectId, query, {
    includeTotal: false,
    source: {
      ...DEFAULT_OBJECT_QUERY_SOURCE,
      objectsTable: `(SELECT * FROM objects WHERE ${item.scope} AND NOT (${compact}) OFFSET 0) AS _sixb_facet_overflow`,
    },
  })
  const offset = args.length
  const overflowSql = overflow.sql.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + offset}`)
  args.push(...overflow.args)
  const overflowFields = facets
    .map((facet, i) => {
      const property = bind(facet.propertyId)
      return `jsonb_typeof(properties -> ${property}::text) AS f${i}_type, properties ->> ${property}::text AS f${i}_value`
    })
    .join(", ")

  // Probe at most 4097 matches before choosing the broad covering-index scan.
  const native = hasText
    ? `WITH _sixb_bounded AS MATERIALIZED (SELECT ${fields} FROM objects WHERE ${nativeWhere.join(" AND ")} LIMIT 4097)
       SELECT * FROM _sixb_bounded WHERE (SELECT count(*) FROM _sixb_bounded) <= 4096
       UNION ALL SELECT ${fields} FROM objects WHERE ${nativeBroad.join(" AND ")} AND (SELECT count(*) FROM _sixb_bounded) > 4096`
    : `SELECT ${fields} FROM objects WHERE ${nativeWhere.join(" AND ")}`
  return compilePgFacetSummary(
    {
      sql: `SELECT * FROM (${native}) AS _sixb_native_facets UNION ALL SELECT ${overflowFields} FROM (${overflowSql}) AS _sixb_overflow_facets`,
      args,
    },
    facets,
    true
  )
}

function compileIndexedCount({
  projectId,
  query,
  item,
  where,
  broadWhere,
  args,
}: IndexedAggregateInput): { sql: string; args: unknown[] } {
  const overflow = compilePgObjectCountQuery(projectId, query, {
    source: {
      ...DEFAULT_OBJECT_QUERY_SOURCE,
      objectsTable: `(SELECT * FROM objects WHERE ${item.scope} AND NOT (${item.compact}) OFFSET 0) AS _sixb_long_text`,
    },
  })
  const offset = args.length
  return {
    sql: `WITH _sixb_bounded_text_count AS MATERIALIZED (SELECT 1 FROM objects WHERE ${where.join(" AND ")} LIMIT 4097)
      SELECT CASE WHEN (SELECT count(*) FROM _sixb_bounded_text_count) > 4096
        THEN (SELECT count(*) FROM objects WHERE ${broadWhere.join(" AND ")})
        ELSE (SELECT count(*) FROM _sixb_bounded_text_count) END
        + (${overflow.sql.replace(/\$(\d+)/g, (_, number) => `$${Number(number) + offset}`)}) AS count`,
    args: [...args, ...overflow.args],
  }
}

function flatCount(query: ObjectQuery):
  | {
      objectTypeId: string
      text: Extract<ObjectQuery, { kind: "text" }>[]
      predicates: ObjectQueryPredicate[]
    }
  | undefined {
  if (query.kind === "start")
    return query.includeSubtypes
      ? undefined
      : { objectTypeId: query.objectTypeId, text: [], predicates: [] }
  if (!["filter", "text", "sort", "expand"].includes(query.kind) || !("input" in query))
    return undefined
  const shape = flatCount(query.input)
  if (!shape) return undefined
  if (query.kind === "text") shape.text.push(query)
  if (query.kind === "filter") shape.predicates.push(query.predicate)
  return shape
}

function stringPredicate(
  predicate: ObjectQueryPredicate,
  columns: ReadonlyMap<string, string>,
  bind: (value: unknown) => string
): string | undefined {
  if (predicate.op === "and" || predicate.op === "or") {
    if (!predicate.items.length) return predicate.op === "and" ? "true" : "false"
    const items = predicate.items.map((item) => stringPredicate(item, columns, bind))
    return items.every((item) => item !== undefined)
      ? `(${items.join(predicate.op === "and" ? " AND " : " OR ")})`
      : undefined
  }
  if ((predicate.op !== "eq" && predicate.op !== "in") || predicate.scalarKind === "decimal")
    return undefined
  const column = columns.get(predicate.propertyId)
  if (!column) return undefined
  const values = predicate.op === "in" ? predicate.values : [predicate.value]
  if (!values.every((value) => typeof value === "string")) return undefined
  return values.length
    ? `${identifier(column)} IN (${values.map((value) => `${bind(value)}::text`).join(", ")})`
    : "false"
}

function parseDefinition(text: string): PgObjectTextCountIndex | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (
      !value ||
      typeof value !== "object" ||
      !("projectId" in value) ||
      typeof value.projectId !== "string" ||
      !("objectTypeId" in value) ||
      typeof value.objectTypeId !== "string" ||
      !("propertyId" in value) ||
      typeof value.propertyId !== "string" ||
      !("filters" in value) ||
      !Array.isArray(value.filters) ||
      value.filters.length > 4 ||
      !value.filters.every((field) => typeof field === "string")
    )
      return undefined
    return {
      projectId: value.projectId,
      objectTypeId: value.objectTypeId,
      propertyId: value.propertyId,
      filters: value.filters,
    }
  } catch {
    return undefined
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function literal(value: string): string {
  if (value.includes("\0")) throw new Error("[SixbPg] Text count identifiers cannot contain NUL")
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}
