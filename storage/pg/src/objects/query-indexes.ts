import { createHash } from "node:crypto"
import type { ObjectQuery, QueryScalarKind } from "@sixb/core"
import type { ReservedSQL, SQL, SQLClient } from "../pg-client"
import { isConnectionLost } from "../storage-errors"
import { withReservedPgConnection } from "../transactions"
import { lockPgPreparation } from "./preparation-lock"

export interface PgObjectQueryIndexScope {
  readonly projectId: string
  readonly objectTypeId: string
  /** Optional equality conditions. Partial indexes also accelerate exact counts of these views. */
  readonly where?: Readonly<Record<string, string | number | boolean | null>>
}

export type PgObjectQueryIndex = PgObjectQueryIndexScope &
  (
    | {
        readonly kind: "sort"
        /** Leading string equality filters, in query order. */
        readonly equality?: readonly string[]
        readonly fields: readonly {
          readonly propertyId: string
          readonly direction?: "asc" | "desc"
          readonly scalarKind?: QueryScalarKind
        }[]
      }
    | { readonly kind: "incomingLinks"; readonly where?: never }
    | { readonly kind: "text"; readonly propertyId: string }
    | { readonly kind: "value"; readonly propertyId: string }
    | { readonly kind: "count" }
    | { readonly kind: "filter"; readonly properties: readonly string[] }
  )

/** Explicit maintenance operation: never creates indexes in the request path or a transaction. */
export async function ensurePgObjectQueryIndexes(
  sql: SQL | ReservedSQL,
  schema: string,
  indexes: readonly PgObjectQueryIndex[]
): Promise<readonly string[]> {
  const definitions = indexes.map((index) => ({
    table: index.kind === "incomingLinks" ? "links" : "objects",
    expression: compileIndex(index),
    index,
  }))
  if (indexes.some((index) => index.kind === "text")) {
    const [extension] = await sql<{ ready: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
      ) AS ready`
    if (!extension?.ready) {
      throw new Error(
        "[SixbPg] Text query indexes require pg_trgm in schema public. Run CREATE EXTENSION pg_trgm WITH SCHEMA public before ensuring indexes."
      )
    }
  }

  const names: string[] = []
  await withReservedPgConnection(sql, async (connection) => {
    let connected = true
    try {
      // One concurrent build per table, across definitions and across processes.
      await lockPgPreparation(connection, `${schema}.objects.query-indexes`)
      for (const definition of definitions) {
        names.push(await createQueryIndex(connection, schema, definition))
      }

      await ensureExpressionStatistics(connection, schema, indexes)
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

async function createQueryIndex(
  connection: ReservedSQL,
  schema: string,
  definition: { table: string; expression: string; index: PgObjectQueryIndex }
): Promise<string> {
  const name = `sixb_query_${createHash("sha256")
    .update(
      definition.table === "objects"
        ? definition.expression
        : `${definition.table}:${definition.expression}`
    )
    .digest("hex")
    .slice(0, 32)}`
  await connection.unsafe(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${identifier(name)} ON ${identifier(schema)}.${identifier(definition.table)} ${definition.expression}`
  )
  const [index] = await connection<{ valid: boolean }[]>`
    SELECT i.indisvalid AS valid FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${name}`
  if (!index?.valid)
    throw new Error(
      `[SixbPg] Query index ${schema}.${name} is invalid after an interrupted build. Drop that index concurrently and retry ensureObjectQueryIndexes().`
    )
  if (definition.index.kind === "sort") {
    await connection.unsafe(
      `COMMENT ON INDEX ${identifier(schema)}.${identifier(name)} IS ${literal(JSON.stringify(definition.index))}`
    )
    const scope = `project_id = ${literal(definition.index.projectId)} AND object_type_id = ${literal(definition.index.objectTypeId)}`
    await connection.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${identifier(`${name}_overflow`)} ON ${identifier(schema)}.objects (primary_id) WHERE ${scope} AND NOT (${sortIndexBound(definition.index)})`
    )
  }
  return name
}

async function ensureExpressionStatistics(
  connection: ReservedSQL,
  schema: string,
  indexes: readonly PgObjectQueryIndex[]
): Promise<void> {
  let statisticsChanged = false
  // Partial-index statistics do not describe expressions for the whole table. Without
  // expression statistics JSON's default selectivity can turn a 4M-row view into an
  // estimated 125-row sort, even when the right ordered index exists.
  const expressions = new Set(indexes.flatMap(statisticsExpressions))
  for (const expression of expressions) {
    const name = `sixb_query_stats_${createHash("sha256").update(expression).digest("hex").slice(0, 24)}`
    const [existing] = await connection`
      SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
      WHERE n.nspname = ${schema} AND s.stxname = ${name}`
    if (existing) continue
    await connection.unsafe(
      `CREATE STATISTICS ${identifier(schema)}.${identifier(name)} ON project_id, object_type_id, ${expression} FROM ${identifier(schema)}.objects`
    )
    statisticsChanged = true
  }
  if (statisticsChanged) await connection.unsafe(`ANALYZE ${identifier(schema)}.objects`)
}

function statisticsExpressions(index: PgObjectQueryIndex): string[] {
  if (index.kind === "incomingLinks") return []
  const equality = new Set(Object.keys(index.where ?? {}))
  if (index.kind === "filter") for (const property of index.properties) equality.add(property)
  if (index.kind === "sort") for (const property of index.equality ?? []) equality.add(property)
  const expressions = [...equality].map(
    (property) =>
      `jsonb_typeof(properties -> ${literal(property)}), (properties ->> ${literal(property)}), (md5(properties ->> ${literal(property)}))`
  )
  if (index.kind === "value") expressions.push(`(properties -> ${literal(index.propertyId)})`)
  if (index.kind === "text")
    expressions.push(`lower(coalesce(properties ->> ${literal(index.propertyId)}, ''))`)
  if (index.kind === "sort")
    for (const field of index.fields) {
      expressions.push(
        field.scalarKind === "decimal"
          ? `((properties ->> ${literal(field.propertyId)})::numeric)`
          : `(NULLIF(properties -> ${literal(field.propertyId)}, 'null'::jsonb))`
      )
    }
  return expressions
}

function compileIndex(index: PgObjectQueryIndex): string {
  if (index.kind === "incomingLinks") {
    if (index.where)
      throw new Error("[SixbPg] Incoming link indexes do not accept object property conditions")
    return `(target_id, link_id, source_type_id, source_id) INCLUDE (project_id, target_type_id) WHERE project_id = ${literal(index.projectId)} AND target_type_id = ${literal(index.objectTypeId)}`
  }
  const predicate = [
    `project_id = ${literal(index.projectId)}`,
    `object_type_id = ${literal(index.objectTypeId)}`,
  ]
  for (const [propertyId, value] of Object.entries(index.where ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const property = `properties -> ${literal(propertyId)}`
    if (value === null) predicate.push(`jsonb_typeof(${property}) = 'null'`)
    else if (typeof value === "string") {
      predicate.push(
        `jsonb_typeof(${property}) = 'string'`,
        `properties ->> ${literal(propertyId)} = ${literal(value)}`,
        `md5(properties ->> ${literal(propertyId)}) = md5(${literal(value)})`
      )
    } else {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("[SixbPg] Query index conditions require finite numbers")
      }
      predicate.push(`${property} = ${literal(JSON.stringify(value))}::jsonb`)
    }
  }
  if (index.kind === "text") {
    return `USING gin (lower(coalesce(properties ->> ${literal(index.propertyId)}, '')) public.gin_trgm_ops) WHERE ${predicate.join(" AND ")}`
  }

  // The partial predicate fixes the scope. Repeating those columns as leading keys
  // makes PostgreSQL scan past them when it removes their redundant conditions.
  const fields: string[] = []
  if (index.kind === "count") {
    fields.push("project_id", "object_type_id")
  } else if (index.kind === "value") {
    fields.push(`(properties -> ${literal(index.propertyId)})`)
  }

  if (index.kind === "filter") {
    if (!index.properties.length || index.properties.length > 8)
      throw new Error("[SixbPg] A filter index requires one to eight string properties")
    for (const propertyId of index.properties)
      fields.push(`(md5(properties ->> ${literal(propertyId)}))`)
  }
  if (index.kind === "sort") {
    predicate.push(sortIndexBound(index))
    if (index.fields.length === 0 || index.fields.length + (index.equality?.length ?? 0) > 8) {
      throw new Error("[SixbPg] A sort query index requires between one and eight fields")
    }
    for (const propertyId of index.equality ?? []) {
      fields.push(`(properties ->> ${literal(propertyId)})`)
    }
    for (const field of index.fields) {
      const property = `properties -> ${literal(field.propertyId)}`
      fields.push(
        `(CASE WHEN jsonb_typeof(${property}) IS NULL OR jsonb_typeof(${property}) = 'null' THEN 1 ELSE 0 END)`,
        `${field.scalarKind === "decimal" ? `((properties ->> ${literal(field.propertyId)})::numeric)` : `(NULLIF(${property}, 'null'::jsonb))`} ${field.direction === "desc" ? "DESC" : "ASC"}`
      )
    }
    fields.push("primary_id")
  }
  return `(${fields.join(", ")}) WHERE ${predicate.join(" AND ")}`
}

function literal(value: string): string {
  if (value.includes("\0"))
    throw new Error("[SixbPg] Query index names and values cannot contain NUL")
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Keep complete B-tree entries below PostgreSQL's page limit, without constraining valid data.
 * Ordered reads merge a small indexed page with the exact overflow page. */
export function sortIndexBound(index: Extract<PgObjectQueryIndex, { kind: "sort" }>): string {
  const sizes = [
    "octet_length(primary_id)",
    ...index.fields.map(
      (field) => `coalesce(octet_length((properties -> ${literal(field.propertyId)})::text), 0)`
    ),
    ...(index.equality ?? []).map(
      (property) => `coalesce(octet_length(properties ->> ${literal(property)}), 0)`
    ),
  ]
  return `(${sizes.join(" + ")}) <= 1800`
}

/** Only split a flat, bounded ordered read; joins, nested limits and projections keep the
 * general compiler. Its unrestricted fallback always preserves semantics. */
export async function findPgSortIndexBound(
  sql: SQLClient,
  projectId: string,
  query: ObjectQuery
): Promise<string | undefined> {
  while (query.kind === "expand") query = query.input
  if (query.kind !== "page" && query.kind !== "limit") return undefined
  let input = query.input
  let fields: Extract<ObjectQuery, { kind: "sort" }>["fields"] | undefined
  const equality = new Set<string>()
  while (input.kind === "sort" || input.kind === "filter" || input.kind === "text") {
    if (input.kind === "sort") {
      if (fields) return undefined
      fields = input.fields
    }
    if (input.kind === "filter") {
      const inspect = (predicate: Extract<ObjectQuery, { kind: "filter" }>["predicate"]): void => {
        if (predicate.op === "and") predicate.items.forEach(inspect)
        else if (predicate.op === "eq" && typeof predicate.value === "string")
          equality.add(predicate.propertyId)
        else if (
          predicate.op === "in" &&
          predicate.values.length === 1 &&
          typeof predicate.values[0] === "string"
        )
          equality.add(predicate.propertyId)
      }
      inspect(input.predicate)
    }
    input = input.input
  }
  let objectTypeId: string | undefined
  if (input.kind === "start" && !input.includeSubtypes) {
    objectTypeId = input.objectTypeId
  } else if (input.kind === "traverse" && input.direction === "incoming") {
    objectTypeId = input.sourceObjectTypeId
  }

  if (!objectTypeId || !fields?.length || fields.some((field) => field.kind !== "property"))
    return undefined

  const rows = await sql<{ definition: string }[]>`
    SELECT obj_description(c.oid, 'pg_class') AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'objects'::regclass AND i.indisvalid
      AND c.relname LIKE 'sixb_query_%'
      AND obj_description(c.oid, 'pg_class') IS NOT NULL
  `
  const matches: Extract<PgObjectQueryIndex, { kind: "sort" }>[] = []
  for (const row of rows) {
    let candidate: unknown
    try {
      candidate = JSON.parse(row.definition)
    } catch {
      continue
    }
    if (!candidate || typeof candidate !== "object") continue
    // Metadata is generated by this module. Verify all SQL-interpolated members before using it.
    const index = candidate as Partial<Extract<PgObjectQueryIndex, { kind: "sort" }>>
    if (
      index.kind !== "sort" ||
      index.projectId !== projectId ||
      index.objectTypeId !== objectTypeId ||
      index.where ||
      !Array.isArray(index.fields) ||
      index.fields.length !== fields.length
    )
      continue
    if (
      index.equality !== undefined &&
      (!Array.isArray(index.equality) ||
        !index.equality.every((property) => typeof property === "string" && equality.has(property)))
    )
      continue
    if (
      !index.fields.every(
        (field, i) =>
          field &&
          typeof field.propertyId === "string" &&
          fields[i]?.kind === "property" &&
          fields[i].propertyId === field.propertyId &&
          (field.direction ?? "asc") === (fields[i].direction ?? "asc") &&
          (field.scalarKind === "decimal") === (fields[i].scalarKind === "decimal")
      )
    )
      continue
    matches.push(index as Extract<PgObjectQueryIndex, { kind: "sort" }>)
  }
  matches.sort((a, b) => (b.equality?.length ?? 0) - (a.equality?.length ?? 0))
  return matches[0] ? sortIndexBound(matches[0]) : undefined
}
