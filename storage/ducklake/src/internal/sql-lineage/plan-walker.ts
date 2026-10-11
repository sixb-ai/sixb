import { expressionDependencies, nestedOrderExpressions, orderExpressions } from "./expressions"
import {
  asIndexList,
  asList,
  asObject,
  booleanField,
  field,
  indexField,
  indexListField,
  type JsonObject,
  listField,
  objectField,
  objectListField,
  stringField,
  stringListField,
} from "./plan-json"
import {
  addAll,
  bindingKey,
  type Dependencies,
  itemAt,
  type PlanColumn,
  type PlanRelation,
  sameDependencies,
  unionOf,
  VIRTUAL_COLUMN,
} from "./plan-relation"
import { reject, rejectPlanFormat } from "./rejection"
import { PURE_TABLE_FUNCTIONS } from "./table-functions"

/** The tables a plan may scan: physical table name, then column name, to a source column id. */
export type PlanSourceTables = ReadonlyMap<string, ReadonlyMap<string, number>>

/** Source column ids, sorted, for the whole result and for each output column by position. */
export interface PlanLineage {
  readonly rows: readonly number[]
  readonly columns: readonly (readonly number[])[]
}

interface WalkContext {
  readonly tables: PlanSourceTables
  /** CTE definitions by table index, set where the CTE is declared. */
  readonly ctes: Map<number, PlanRelation>
  /** Duplicate-eliminated columns of the enclosing DELIM_JOINs, innermost last. */
  readonly delimColumns: (readonly PlanColumn[])[]
}

/** Recursive CTE lineage grows monotonically; real queries settle within a few rounds. */
const MAX_RECURSIVE_CTE_ROUNDS = 64

/**
 * Column lineage of one bound, unoptimized logical plan (`json_serialize_plan(sql, optimize :=
 * false)`), walked bottom-up. Each operator yields its output columns with the source columns their
 * values come from, plus the source columns that decide which rows exist or their order. Those row
 * dependencies accumulate upwards and apply to every output column.
 *
 * Expressions mostly reference their operator's input by position, so each operator below states
 * the order of its output columns.
 */
export function planLineage(plan: unknown, tables: PlanSourceTables): PlanLineage {
  const root = evaluate(asObject(plan, "plan"), { tables, ctes: new Map(), delimColumns: [] })
  const rows = sortedIds(root.rows)
  const columns = root.columns.map((column) => sortedIds(column.dependencies))

  if ([rows, ...columns].some((ids) => ids.includes(VIRTUAL_COLUMN))) {
    reject("reading virtual columns such as rowid is not supported")
  }

  return { rows, columns }
}

function evaluate(node: JsonObject, context: WalkContext): PlanRelation {
  const type = stringField(node, "type")

  switch (type) {
    case "LOGICAL_GET":
      return evaluateGet(node, context)
    case "LOGICAL_DUMMY_SCAN":
      return evaluateDummyScan(node)
    case "LOGICAL_EXPRESSION_GET":
      return evaluateExpressionGet(node, context)
    case "LOGICAL_PROJECTION":
      return evaluateProjection(node, context)
    case "LOGICAL_FILTER":
      return evaluateFilter(node, context)
    case "LOGICAL_AGGREGATE_AND_GROUP_BY":
      return evaluateAggregate(node, context)
    case "LOGICAL_WINDOW":
      return evaluateWindow(node, context)
    case "LOGICAL_UNNEST":
      return evaluateUnnest(node, context)
    case "LOGICAL_ORDER_BY":
      return evaluateOrderBy(node, context)
    case "LOGICAL_LIMIT":
      return evaluateLimit(node, context)
    case "LOGICAL_SAMPLE":
      // A random sample: no column decides which rows survive.
      return evaluateOnlyChild(node, context)
    case "LOGICAL_DISTINCT":
      return evaluateDistinct(node, context)
    case "LOGICAL_CROSS_PRODUCT":
    case "LOGICAL_POSITIONAL_JOIN":
      return evaluateCrossProduct(node, context)
    case "LOGICAL_COMPARISON_JOIN":
    case "LOGICAL_ASOF_JOIN":
      return evaluateComparisonJoin(node, context)
    case "LOGICAL_DELIM_JOIN":
      return evaluateDelimJoin(node, context)
    case "LOGICAL_ANY_JOIN":
      return evaluateAnyJoin(node, context)
    case "LOGICAL_DELIM_GET":
      return evaluateDelimGet(node, context)
    case "LOGICAL_UNION":
    case "LOGICAL_EXCEPT":
    case "LOGICAL_INTERSECT":
      return evaluateSetOperation(node, context)
    case "LOGICAL_MATERIALIZED_CTE":
      return evaluateMaterializedCte(node, context)
    case "LOGICAL_RECURSIVE_CTE":
      return evaluateRecursiveCte(node, context)
    case "LOGICAL_CTE_REF":
      return evaluateCteRef(node, context)
    default:
      reject(`plan node '${type}' is not supported`)
  }
}

interface ScanSource {
  /** Source columns behind the scanned column at a table or function column index. */
  readonly column: (index: number) => Dependencies
  readonly rows: Dependencies
}

/**
 * Output: the scanned columns (column_indexes), narrowed to projection_ids when present, then the
 * input columns an in-out table function passes through (projected_input).
 */
function evaluateGet(node: JsonObject, context: WalkContext): PlanRelation {
  if (objectListField(objectField(node, "table_filters"), "filters").length > 0) {
    rejectPlanFormat("an unoptimized scan has pushed-down filters")
  }

  const inputs = objectListField(node, "children")
  if (inputs.length > 1) {
    rejectPlanFormat("a scan has several inputs")
  }

  const input = inputs[0] === undefined ? undefined : evaluate(inputs[0], context)
  const functionName = stringField(node, "name")
  const source =
    functionName === "seq_scan"
      ? tableScanSource(node, context, input)
      : tableFunctionSource(functionName, input)

  const scanned = objectListField(node, "column_indexes").map((entry) =>
    source.column(indexField(entry, "index"))
  )
  const tableIndex = indexField(node, "table_index")
  const projectionIds = indexListField(node, "projection_ids")
  const positions = projectionIds.length > 0 ? projectionIds : scanned.map((_, index) => index)

  const columns: PlanColumn[] = positions.map((position) => ({
    dependencies: itemAt(scanned, position, "scanned column"),
    binding: bindingKey(tableIndex, position),
  }))

  for (const position of indexListField(node, "projected_input")) {
    if (input === undefined) {
      rejectPlanFormat("a scan passes through input columns without an input")
    }

    columns.push(itemAt(input.columns, position, "input column"))
  }

  return { columns, rows: unionOf(input?.rows ?? new Set(), source.rows) }
}

function tableScanSource(
  node: JsonObject,
  context: WalkContext,
  input: PlanRelation | undefined
): ScanSource {
  if (input !== undefined) {
    rejectPlanFormat("a table scan has an input")
  }

  const table = stringField(objectField(node, "function_data"), "table")
  const columnIds = context.tables.get(table)
  if (columnIds === undefined) {
    reject(`table '${table}' is not a source of the transform`)
  }

  const names = stringListField(node, "names")
  return {
    rows: new Set(),
    column: (index) => {
      // Indexes past the table's columns are planner-internal virtual columns.
      const name = names[index]
      if (name === undefined) {
        return new Set([VIRTUAL_COLUMN])
      }

      const id = columnIds.get(name)
      if (id === undefined) {
        rejectPlanFormat(`table '${table}' has no column '${name}'`)
      }

      return new Set([id])
    },
  }
}

/**
 * Without an input, a table function's arguments are bound constants. With one (LATERAL arguments,
 * or a subquery as an argument), every produced column and the number of rows derive from it.
 */
function tableFunctionSource(name: string, input: PlanRelation | undefined): ScanSource {
  if (!PURE_TABLE_FUNCTIONS.has(name)) {
    reject(`table function '${name}' is not supported`)
  }

  const dependencies =
    input === undefined
      ? new Set<number>()
      : unionOf(...input.columns.map((column) => column.dependencies))

  return { rows: dependencies, column: () => dependencies }
}

/** `SELECT` without FROM: one row of one placeholder column. */
function evaluateDummyScan(node: JsonObject): PlanRelation {
  assertLeaf(node)
  return {
    columns: [{ dependencies: new Set(), binding: bindingKey(indexField(node, "table_index"), 0) }],
    rows: new Set(),
  }
}

/** VALUES: column i is the union of every row's i-th expression. */
function evaluateExpressionGet(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)
  const width = listField(node, "expr_types").length
  const values = Array.from({ length: width }, () => new Set<number>())

  for (const row of listField(node, "expressions")) {
    const expressions = asList(row, "a VALUES row")
    if (expressions.length !== width) {
      rejectPlanFormat("a VALUES row does not match the VALUES width")
    }

    expressions.forEach((expression, index) => {
      addAll(
        itemAt(values, index, "VALUES column"),
        expressionDependencies(expression, input.columns)
      )
    })
  }

  const tableIndex = indexField(node, "table_index")
  return {
    columns: values.map((dependencies, index) => ({
      dependencies,
      binding: bindingKey(tableIndex, index),
    })),
    rows: input.rows,
  }
}

function evaluateProjection(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)
  const tableIndex = indexField(node, "table_index")

  return {
    columns: listField(node, "expressions").map((expression, index) => ({
      dependencies: expressionDependencies(expression, input.columns),
      binding: bindingKey(tableIndex, index),
    })),
    rows: input.rows,
  }
}

/** Output: the window's input columns, then one column per window expression (window_index). */
function evaluateWindow(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)
  const windowIndex = indexField(node, "window_index")
  const rows = new Set(input.rows)

  const windows = objectListField(node, "expressions").map((expression, index) => {
    if (stringField(expression, "expression_class") !== "BOUND_WINDOW") {
      rejectPlanFormat("a window operator computes something other than a window function")
    }

    // Partitions and orders decide which rows each window function compares.
    addAll(rows, dependenciesOf(listField(expression, "partitions"), input.columns))
    addAll(rows, dependenciesOf(orderExpressions(listField(expression, "orders")), input.columns))

    return {
      dependencies: expressionDependencies(expression, input.columns),
      binding: bindingKey(windowIndex, index),
    }
  })

  return { columns: [...input.columns, ...windows], rows }
}

function evaluateFilter(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)

  return {
    columns: projectColumns(input.columns, indexListField(node, "projection_map")),
    rows: unionOf(input.rows, dependenciesOf(listField(node, "expressions"), input.columns)),
  }
}

/**
 * Output: the groups (group_index), the aggregates (aggregate_index), then one GROUPING() column
 * per grouping function (groupings_index). HAVING is a filter above this operator.
 */
function evaluateAggregate(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)
  const groups = listField(node, "groups").map((expression) =>
    expressionDependencies(expression, input.columns)
  )
  const groupIndex = indexField(node, "group_index")
  const aggregateIndex = indexField(node, "aggregate_index")
  const groupingsIndex = indexField(node, "groupings_index")

  const groupColumns = groups.map((dependencies, index) => ({
    dependencies,
    binding: bindingKey(groupIndex, index),
  }))
  const aggregateColumns = listField(node, "expressions").map((expression, index) => ({
    dependencies: expressionDependencies(expression, input.columns),
    binding: bindingKey(aggregateIndex, index),
  }))
  // GROUPING(a, b) tells which of the groups it lists are rolled up in a row.
  const groupingColumns = listField(node, "grouping_functions").map((groupIndexes, index) => ({
    dependencies: unionOf(
      ...asIndexList(groupIndexes, "a grouping function").map((group) =>
        itemAt(groups, group, "group")
      )
    ),
    binding: bindingKey(groupingsIndex, index),
  }))

  return {
    columns: [...groupColumns, ...aggregateColumns, ...groupingColumns],
    rows: unionOf(input.rows, ...groups),
  }
}

/**
 * Output: the input columns, then one column per UNNEST (unnest_index). Unnesting turns each row
 * into as many rows as its list has items, so the lists are row dependencies too.
 */
function evaluateUnnest(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)
  const unnestIndex = indexField(node, "unnest_index")
  const rows = new Set(input.rows)

  const unnested = listField(node, "expressions").map((expression, index) => {
    const dependencies = expressionDependencies(expression, input.columns)
    addAll(rows, dependencies)
    return { dependencies, binding: bindingKey(unnestIndex, index) }
  })

  return { columns: [...input.columns, ...unnested], rows }
}

/** A row dependency even without LIMIT: a materialized dataset keeps its row order. */
function evaluateOrderBy(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)

  return {
    columns: projectColumns(input.columns, indexListField(node, "projections")),
    rows: unionOf(
      input.rows,
      dependenciesOf(orderExpressions(listField(node, "orders")), input.columns)
    ),
  }
}

function evaluateLimit(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)

  return {
    columns: input.columns,
    rows: unionOf(
      input.rows,
      limitDependencies(objectField(node, "limit_val"), input.columns),
      limitDependencies(objectField(node, "offset_val"), input.columns)
    ),
  }
}

function limitDependencies(limit: JsonObject, input: readonly PlanColumn[]): Dependencies {
  const kind = stringField(limit, "type")

  switch (kind) {
    case "UNSET":
    case "CONSTANT_VALUE":
    case "CONSTANT_PERCENTAGE":
      return new Set()
    case "EXPRESSION_VALUE":
    case "EXPRESSION_PERCENTAGE":
      return expressionDependencies(field(limit, "expression"), input)
    default:
      reject(`LIMIT kind '${kind}' is not supported`)
  }
}

/** DISTINCT, DISTINCT ON with its ORDER BY, and the deduplication of set operations. */
function evaluateDistinct(node: JsonObject, context: WalkContext): PlanRelation {
  const input = evaluateOnlyChild(node, context)

  return {
    columns: input.columns,
    rows: unionOf(
      input.rows,
      dependenciesOf(listField(node, "distinct_targets"), input.columns),
      dependenciesOf(nestedOrderExpressions(node, "order_by"), input.columns)
    ),
  }
}

/** Output: the left columns, then the right columns. */
function evaluateCrossProduct(node: JsonObject, context: WalkContext): PlanRelation {
  const [left, right] = evaluateTwoChildren(node, context)
  return { columns: [...left.columns, ...right.columns], rows: unionOf(left.rows, right.rows) }
}

function evaluateComparisonJoin(node: JsonObject, context: WalkContext): PlanRelation {
  const [left, right] = evaluateTwoChildren(node, context)
  return comparisonJoinOutput(node, left, right)
}

/**
 * A correlated subquery, flattened. The duplicate-eliminated columns are computed over one side
 * (the left, unless delim_flipped), and every DELIM_GET on the other side reads them.
 */
function evaluateDelimJoin(node: JsonObject, context: WalkContext): PlanRelation {
  const [first, second] = twoChildren(node)
  const flipped = booleanField(node, "delim_flipped")
  const outer = evaluate(flipped ? second : first, context)

  context.delimColumns.push(
    listField(node, "duplicate_eliminated_columns").map((expression) => ({
      dependencies: expressionDependencies(expression, outer.columns),
    }))
  )
  const inner = evaluate(flipped ? first : second, context)
  context.delimColumns.pop()

  return flipped
    ? comparisonJoinOutput(node, inner, outer)
    : comparisonJoinOutput(node, outer, inner)
}

/** Each side of a condition reads its own input; the residual predicate reads left ++ right. */
function comparisonJoinOutput(
  node: JsonObject,
  left: PlanRelation,
  right: PlanRelation
): PlanRelation {
  const condition = new Set<number>()

  for (const comparison of objectListField(node, "conditions")) {
    addAll(condition, expressionDependencies(field(comparison, "left"), left.columns))
    addAll(condition, expressionDependencies(field(comparison, "right"), right.columns))
  }

  const predicate = field(node, "predicate")
  if (predicate !== null) {
    addAll(condition, expressionDependencies(predicate, [...left.columns, ...right.columns]))
  }

  return joinOutput(node, left, right, condition)
}

/** A join on an arbitrary condition, which reads left ++ right. */
function evaluateAnyJoin(node: JsonObject, context: WalkContext): PlanRelation {
  const [left, right] = evaluateTwoChildren(node, context)
  const condition = expressionDependencies(field(node, "condition"), [
    ...left.columns,
    ...right.columns,
  ])

  return joinOutput(node, left, right, condition)
}

/** Which columns a join outputs depends on its type; its condition decides its rows. */
function joinOutput(
  node: JsonObject,
  left: PlanRelation,
  right: PlanRelation,
  condition: Dependencies
): PlanRelation {
  const rows = unionOf(left.rows, right.rows, condition)
  const leftColumns = projectColumns(left.columns, indexListField(node, "left_projection_map"))
  const rightColumns = projectColumns(right.columns, indexListField(node, "right_projection_map"))
  const joinType = stringField(node, "join_type")

  switch (joinType) {
    case "INNER":
    case "LEFT":
    case "RIGHT":
    case "FULL":
    case "SINGLE": // a correlated scalar subquery
      return { columns: [...leftColumns, ...rightColumns], rows }
    case "SEMI":
    case "ANTI":
      return { columns: leftColumns, rows }
    case "RIGHT_SEMI":
    case "RIGHT_ANTI":
      return { columns: rightColumns, rows }
    case "MARK": {
      // EXISTS, IN or ANY used as a value: a boolean column (mark_index) telling whether the
      // condition matched.
      const mark = {
        dependencies: condition,
        binding: bindingKey(indexField(node, "mark_index"), 0),
      }
      return { columns: [...leftColumns, mark], rows }
    }
    default:
      reject(`join type '${joinType}' is not supported`)
  }
}

function evaluateDelimGet(node: JsonObject, context: WalkContext): PlanRelation {
  assertLeaf(node)
  const delimColumns = context.delimColumns.at(-1)
  if (delimColumns === undefined) {
    rejectPlanFormat("a DELIM_GET is outside any DELIM_JOIN")
  }

  if (listField(node, "chunk_types").length !== delimColumns.length) {
    rejectPlanFormat("a DELIM_GET does not match its DELIM_JOIN")
  }

  return { columns: rebind(delimColumns, indexField(node, "table_index")), rows: new Set() }
}

/** UNION ALL chains are flattened: a set operation may have more than two inputs. */
function evaluateSetOperation(node: JsonObject, context: WalkContext): PlanRelation {
  const inputs = objectListField(node, "children").map((child) => evaluate(child, context))
  const width = indexField(node, "column_count")
  if (inputs.length < 2 || inputs.some((input) => input.columns.length !== width)) {
    rejectPlanFormat("set operation inputs do not match")
  }

  const tableIndex = indexField(node, "table_index")
  const rows = unionOf(...inputs.map((input) => input.rows))

  if (stringField(node, "type") === "LOGICAL_UNION") {
    const columns = Array.from({ length: width }, (_, index) => ({
      dependencies: unionOf(
        ...inputs.map((input) => itemAt(input.columns, index, "column").dependencies)
      ),
      binding: bindingKey(tableIndex, index),
    }))

    // Without ALL, deduplication compares every column.
    if (!booleanField(node, "setop_all")) {
      addAll(rows, unionOf(...columns.map((column) => column.dependencies)))
    }

    return { columns, rows }
  }

  // EXCEPT and INTERSECT: values come from the first input; whether a row survives depends on
  // every column of every input.
  for (const input of inputs) {
    addAll(rows, unionOf(...input.columns.map((column) => column.dependencies)))
  }

  return { columns: rebind(itemAt(inputs, 0, "input").columns, tableIndex), rows }
}

/**
 * The first input defines the CTE, the second is the query reading it. The planner emits this node
 * for every CTE, materialized or not, since inlining is an optimizer step. A CTE adds its row
 * dependencies only where a CTE_REF reads it.
 */
function evaluateMaterializedCte(node: JsonObject, context: WalkContext): PlanRelation {
  const [definition, query] = twoChildren(node)
  context.ctes.set(indexField(node, "table_index"), evaluate(definition, context))
  return evaluate(query, context)
}

/**
 * The first input is the anchor, the second the recursive step, which reads the CTE through CTE_REFs
 * to this table_index. The step is re-evaluated against the accumulated lineage until it is stable.
 */
function evaluateRecursiveCte(node: JsonObject, context: WalkContext): PlanRelation {
  const [anchorNode, stepNode] = twoChildren(node)
  const tableIndex = indexField(node, "table_index")
  const unionAll = booleanField(node, "union_all")
  const keyTargets = listField(node, "key_targets")
  let current = evaluate(anchorNode, context)

  for (let round = 0; round < MAX_RECURSIVE_CTE_ROUNDS; round += 1) {
    context.ctes.set(tableIndex, current)
    const step = evaluate(stepNode, context)
    if (step.columns.length !== current.columns.length) {
      rejectPlanFormat("recursive CTE branches have different widths")
    }

    const columns = current.columns.map((column, index) => ({
      dependencies: unionOf(
        column.dependencies,
        itemAt(step.columns, index, "column").dependencies
      ),
      binding: bindingKey(tableIndex, index),
    }))
    const rows = unionOf(current.rows, step.rows, dependenciesOf(keyTargets, columns))
    // Without ALL, deduplication compares every column.
    if (!unionAll) {
      addAll(rows, unionOf(...columns.map((column) => column.dependencies)))
    }

    const next = { columns, rows }
    if (sameRelation(current, next)) {
      return next
    }

    current = next
  }

  reject("recursive CTE lineage did not converge")
}

function evaluateCteRef(node: JsonObject, context: WalkContext): PlanRelation {
  assertLeaf(node)
  const definition = context.ctes.get(indexField(node, "cte_index"))
  if (definition === undefined) {
    rejectPlanFormat("a CTE_REF reads an undefined CTE")
  }

  if (listField(node, "chunk_types").length !== definition.columns.length) {
    rejectPlanFormat("a CTE_REF does not match its CTE")
  }

  return {
    columns: rebind(definition.columns, indexField(node, "table_index")),
    rows: definition.rows,
  }
}

function twoChildren(node: JsonObject): readonly [JsonObject, JsonObject] {
  const children = objectListField(node, "children")
  const [first, second] = children
  if (children.length !== 2 || first === undefined || second === undefined) {
    rejectPlanFormat(`'${stringField(node, "type")}' should have two inputs`)
  }

  return [first, second]
}

function evaluateTwoChildren(
  node: JsonObject,
  context: WalkContext
): readonly [PlanRelation, PlanRelation] {
  const [left, right] = twoChildren(node)
  return [evaluate(left, context), evaluate(right, context)]
}

function evaluateOnlyChild(node: JsonObject, context: WalkContext): PlanRelation {
  const children = objectListField(node, "children")
  const [child] = children
  if (children.length !== 1 || child === undefined) {
    rejectPlanFormat(`'${stringField(node, "type")}' should have one input`)
  }

  return evaluate(child, context)
}

function assertLeaf(node: JsonObject): void {
  if (objectListField(node, "children").length > 0) {
    rejectPlanFormat(`'${stringField(node, "type")}' should have no input`)
  }
}

/** An operator's projection map selects input columns by position; empty keeps them all. */
function projectColumns(
  columns: readonly PlanColumn[],
  projectionMap: readonly number[]
): readonly PlanColumn[] {
  return projectionMap.length === 0
    ? columns
    : projectionMap.map((index) => itemAt(columns, index, "projected column"))
}

/** The same columns, exposed under another operator's table index. */
function rebind(columns: readonly PlanColumn[], tableIndex: number): readonly PlanColumn[] {
  return columns.map((column, index) => ({
    dependencies: column.dependencies,
    binding: bindingKey(tableIndex, index),
  }))
}

function dependenciesOf(
  expressions: readonly unknown[],
  input: readonly PlanColumn[]
): Dependencies {
  return unionOf(...expressions.map((expression) => expressionDependencies(expression, input)))
}

function sameRelation(left: PlanRelation, right: PlanRelation): boolean {
  return (
    sameDependencies(left.rows, right.rows) &&
    left.columns.every((column, index) =>
      sameDependencies(column.dependencies, itemAt(right.columns, index, "column").dependencies)
    )
  )
}

function sortedIds(ids: Dependencies): readonly number[] {
  return [...ids].sort((left, right) => left - right)
}
