import {
  asObject,
  booleanField,
  field,
  indexField,
  isJsonObject,
  type JsonObject,
  listField,
  nullableObjectField,
  objectField,
  objectListField,
  stringField,
} from "./plan-json"
import { addAll, bindingKey, itemAt, type PlanColumn } from "./plan-relation"
import { reject, rejectPlanFormat } from "./rejection"

/** Source columns whose values flow into an expression evaluated over an operator's `input`. */
export function expressionDependencies(
  expression: unknown,
  input: readonly PlanColumn[]
): Set<number> {
  const dependencies = new Set<number>()
  addExpression(dependencies, expression, input)
  return dependencies
}

/** The sort expressions of an ORDER BY list (`{ type, null_order, expression }` entries). */
export function orderExpressions(orders: readonly unknown[]): readonly unknown[] {
  return orders.map((order) => field(asObject(order, "sort order"), "expression"))
}

/** `{ orders: [...] }` or null, as aggregates and DISTINCT ON write their ORDER BY. */
export function nestedOrderExpressions(object: JsonObject, key: string): readonly unknown[] {
  const orderBy = nullableObjectField(object, key)
  return orderBy === null ? [] : orderExpressions(listField(orderBy, "orders"))
}

function addExpression(target: Set<number>, value: unknown, input: readonly PlanColumn[]): void {
  const expression = asObject(value, "expression")
  const expressionClass = stringField(expression, "expression_class")

  switch (expressionClass) {
    case "BOUND_REF":
      // Positional: the index-th column of the operator's input.
      addAll(target, itemAt(input, indexField(expression, "index"), "column").dependencies)
      return

    case "BOUND_COLUMN_REF":
      addAll(target, columnByBinding(expression, input).dependencies)
      return

    case "BOUND_CONSTANT":
      return

    case "BOUND_CAST":
    case "BOUND_UNNEST":
      addExpression(target, field(expression, "child"), input)
      return

    case "BOUND_FUNCTION":
      // A lambda body lives in the bind data with its own column numbering, and every column it
      // captures is also passed as an extra child.
      assertNoHiddenExpressions(expression, "lambda_expr")
      addExpressions(target, listField(expression, "children"), input)
      return

    case "BOUND_AGGREGATE":
      // FILTER and ORDER BY shape the aggregated value, as a CASE inside the aggregate would.
      assertNoHiddenExpressions(expression)
      addExpressions(target, listField(expression, "children"), input)
      addOptionalExpression(target, field(expression, "filter"), input)
      addExpressions(target, nestedOrderExpressions(expression, "order_bys"), input)
      return

    case "BOUND_WINDOW":
      addWindowExpression(target, expression, input)
      return

    case "BOUND_COMPARISON":
      addExpression(target, field(expression, "left"), input)
      addExpression(target, field(expression, "right"), input)
      return

    case "BOUND_BETWEEN":
      addExpression(target, field(expression, "input"), input)
      addExpression(target, field(expression, "lower"), input)
      addExpression(target, field(expression, "upper"), input)
      return

    case "BOUND_CONJUNCTION":
    case "BOUND_OPERATOR":
      addExpressions(target, listField(expression, "children"), input)
      return

    case "BOUND_CASE":
      for (const check of objectListField(expression, "case_checks")) {
        addExpression(target, field(check, "when_expr"), input)
        addExpression(target, field(check, "then_expr"), input)
      }

      addExpression(target, field(expression, "else_expr"), input)
      return

    default:
      // Subqueries are always flattened into joins by the planner; parameters, lambda
      // references outside a lambda body, and anything newer are not understood.
      reject(`expression '${expressionClass}' is not supported`)
  }
}

/**
 * PARTITION BY and ORDER BY are value dependencies of the window column; the window operator also
 * adds them to the row dependencies. FILTER, frame bounds, offsets and defaults shape the value.
 */
function addWindowExpression(
  target: Set<number>,
  expression: JsonObject,
  input: readonly PlanColumn[]
): void {
  // Only window aggregates serialize a function, with its bind data; ranking and value functions
  // such as row_number() or lag() have none.
  if (stringField(expression, "type") === "WINDOW_AGGREGATE") {
    assertNoHiddenExpressions(expression)
  }

  addExpressions(target, listField(expression, "children"), input)
  addExpressions(target, listField(expression, "partitions"), input)
  addExpressions(target, orderExpressions(listField(expression, "orders")), input)
  addExpressions(target, orderExpressions(listField(expression, "arg_orders")), input)

  for (const key of ["filters", "start_expr", "end_expr", "offset_expr", "default_expr"]) {
    addOptionalExpression(target, field(expression, key), input)
  }
}

function addExpressions(
  target: Set<number>,
  expressions: readonly unknown[],
  input: readonly PlanColumn[]
): void {
  for (const expression of expressions) {
    addExpression(target, expression, input)
  }
}

function addOptionalExpression(
  target: Set<number>,
  expression: unknown,
  input: readonly PlanColumn[]
): void {
  if (expression !== null) {
    addExpression(target, expression, input)
  }
}

/**
 * DuckDB leaves the subtree under a table function's input unresolved: columns are referenced by
 * their plan binding instead of their position.
 */
function columnByBinding(expression: JsonObject, input: readonly PlanColumn[]): PlanColumn {
  if (indexField(expression, "depth") !== 0) {
    reject("correlated column references that the planner did not flatten are not supported")
  }

  const binding = objectField(expression, "binding")
  const key = bindingKey(indexField(binding, "table_index"), indexField(binding, "column_index"))
  const column = input.find((candidate) => candidate.binding === key)
  if (column === undefined) {
    rejectPlanFormat(`column binding ${key} does not resolve`)
  }

  return column
}

/**
 * Function bind data is opaque to the analysis. It may hold the lambda body of a list function,
 * whose captures are also children; any other expression in it would be a hidden dependency.
 */
function assertNoHiddenExpressions(expression: JsonObject, allowedKey?: string): void {
  // Functions without a serializer rebind from their children: there is no bind data to read.
  if (!booleanField(expression, "has_serialize")) {
    return
  }

  const bindData = field(expression, "function_data")
  const inspected =
    isJsonObject(bindData) && allowedKey !== undefined
      ? Object.entries(bindData).flatMap(([key, value]) => (key === allowedKey ? [] : [value]))
      : [bindData]

  if (inspected.some(containsExpression)) {
    reject(
      `function '${stringField(expression, "name")}' keeps expressions in its bind data, which is not supported`
    )
  }
}

function containsExpression(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsExpression(item))
  }

  if (!isJsonObject(value)) {
    return false
  }

  return Object.hasOwn(value, "expression_class") || Object.values(value).some(containsExpression)
}
