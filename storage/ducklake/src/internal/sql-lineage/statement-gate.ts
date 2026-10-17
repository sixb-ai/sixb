import { isJsonObject, type JsonObject, listField, objectField, stringField } from "./plan-json"
import { reject } from "./rejection"
import { PURE_TABLE_FUNCTIONS } from "./table-functions"

/**
 * Checks the parse tree (`json_serialize_sql`) before DuckDB binds the query. Binding already runs
 * table functions' bind code, and table macros such as `query()` only expand during binding, so
 * they must be refused from the parse tree. PIVOT is refused here because its output columns depend
 * on data the empty analysis tables do not have.
 */
export function assertSingleSelect(statements: readonly unknown[]): void {
  const [statement] = statements
  if (statements.length !== 1 || statement === undefined) {
    reject("the transform must be exactly one SELECT statement")
  }

  visit(statement, (node) => {
    if (node.type === "PIVOT") {
      const unpivot = listField(node, "unpivot_names").length > 0
      reject(`${unpivot ? "UNPIVOT" : "PIVOT"} is not supported`)
    }

    const unread = readsBeyondSources(node)
    if (unread) reject(unread)
  })
}

/**
 * Whether the statement reads nothing but its sources, for a transform the analysis rejected: then
 * every column it outputs depends on at most every column of its sources. PIVOT reads only its
 * input.
 *
 * Data reaches a query through its table references. Each must be one of `sourceTables`, or a
 * common table expression an enclosing query defines; a table function must compute from its
 * arguments alone. A name a query does not define resolves to a table of the lake.
 *
 * A function must carry a name DuckDB itself defines, one of `builtinFunctions`: a macro the
 * lake's setup defines can read any table, and its call shows none.
 */
export function readsOnlySources(
  statements: readonly unknown[],
  sourceTables: ReadonlySet<string>,
  builtinFunctions: ReadonlySet<string>
): boolean {
  const [statement] = statements
  if (statements.length !== 1 || statement === undefined) return false

  let only = true
  visit(statement, (node, ctes) => {
    if (readsBeyondSources(node)) only = false
    else if (node.type === "BASE_TABLE" && !readsSourceOrCte(node, sourceTables, ctes)) only = false
    else if (callsUnknownFunction(node, builtinFunctions)) only = false
  })

  return only
}

/** What makes a node read outside the transform's sources, if anything. */
function readsBeyondSources(node: JsonObject): string | undefined {
  if (node.type === "SHOW_REF") {
    return "DESCRIBE, SHOW and SUMMARIZE are not supported"
  }

  if (node.type === "TABLE_FUNCTION") {
    const name = stringField(objectField(node, "function"), "function_name")
    if (!PURE_TABLE_FUNCTIONS.has(name)) return `table function '${name}' is not supported`
  }

  if (node.class === "PARAMETER") {
    return "query parameters are not supported"
  }

  return undefined
}

function readsSourceOrCte(
  table: JsonObject,
  sourceTables: ReadonlySet<string>,
  ctes: ReadonlySet<string>
): boolean {
  if (qualified(table, "schema_name") || qualified(table, "catalog_name")) return false

  const name = stringField(table, "table_name")
  return sourceTables.has(name) || ctes.has(name.toLowerCase())
}

/**
 * DuckDB writes syntax such as `EXTRACT`, `[1, 2]` or `{a: 1}` as calls to functions of schema
 * `main`, so only another schema or a catalog qualifies a call.
 */
function callsUnknownFunction(node: JsonObject, builtinFunctions: ReadonlySet<string>): boolean {
  if (node.class !== "FUNCTION" && node.class !== "WINDOW") return false
  if (qualified(node, "catalog") || (qualified(node, "schema") && node.schema !== "main")) {
    return true
  }

  const name = node.function_name
  return typeof name !== "string" || !builtinFunctions.has(name.toLowerCase())
}

function qualified(node: JsonObject, key: string): boolean {
  const value = node[key]
  return typeof value === "string" && value !== ""
}

/**
 * Visit every node of a parse tree, with the names of the common table expressions in scope, which
 * DuckDB matches without regard to case.
 *
 * A query's body sees all of its expressions. An expression's own query sees only those defined
 * before it, and a recursive one sees itself in its recursive part alone: any other name resolves
 * to a table of the lake, so `WITH raw AS (SELECT * FROM raw)` reads the lake's `raw`.
 */
function visit(
  value: unknown,
  check: (node: JsonObject, ctes: ReadonlySet<string>) => void,
  ctes: ReadonlySet<string> = new Set()
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, check, ctes)
    return
  }

  if (!isJsonObject(value)) return

  const entries = cteEntries(value)
  const defined = new Set(ctes)
  for (const { name, query } of entries) {
    visit(query, check, new Set(defined))
    defined.add(name)
  }

  check(value, defined)

  const recursive =
    value.type === "RECURSIVE_CTE_NODE" && typeof value.cte_name === "string"
      ? new Set([...defined, value.cte_name.toLowerCase()])
      : undefined

  for (const [key, child] of Object.entries(value)) {
    if (key === "cte_map" && entries.length > 0) continue
    visit(child, check, key === "right" && recursive ? recursive : defined)
  }
}

/**
 * A query's common table expressions, in the order it defines them. A map in a shape this does not
 * know gives none: its nodes are then visited as any others, with no name in scope.
 */
function cteEntries(
  node: JsonObject
): readonly { readonly name: string; readonly query: unknown }[] {
  const map = node.cte_map
  if (!isJsonObject(map) || !Array.isArray(map.map)) return []

  const entries: { name: string; query: unknown }[] = []
  for (const entry of map.map) {
    if (!isJsonObject(entry) || typeof entry.key !== "string" || !isJsonObject(entry.value)) {
      return []
    }
    entries.push({ name: entry.key.toLowerCase(), query: entry.value.query })
  }
  return entries
}
