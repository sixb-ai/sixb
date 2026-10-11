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

  visit(statement)
}

function visit(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(visit)
    return
  }

  if (!isJsonObject(value)) {
    return
  }

  assertSupportedNode(value)
  Object.values(value).forEach(visit)
}

function assertSupportedNode(node: JsonObject): void {
  if (node.type === "PIVOT") {
    const unpivot = listField(node, "unpivot_names").length > 0
    reject(`${unpivot ? "UNPIVOT" : "PIVOT"} is not supported`)
  }

  if (node.type === "SHOW_REF") {
    reject("DESCRIBE, SHOW and SUMMARIZE are not supported")
  }

  if (node.type === "TABLE_FUNCTION") {
    const name = stringField(objectField(node, "function"), "function_name")
    if (!PURE_TABLE_FUNCTIONS.has(name)) {
      reject(`table function '${name}' is not supported`)
    }
  }

  if (node.class === "PARAMETER") {
    reject("query parameters are not supported")
  }
}
