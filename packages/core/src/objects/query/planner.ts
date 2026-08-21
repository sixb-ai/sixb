import type { ObjectQueryCapabilities, ObjectQueryScalarOperation } from "../../storage"
import type { ObjectQueryPlanningIssue } from "./errors"
import type { ObjectExpansion, ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "./ir"

export type ObjectQueryPlanMode = "pushdown" | "fallback" | "rejected"
export type ObjectQueryProviderOperation =
  | "queryObjects"
  | "countObjects"
  | "existsObjects"
  | "facetObjects"

export interface ObjectQueryPlan {
  mode: ObjectQueryPlanMode
  query: ObjectQuery
  providerIssues: readonly ObjectQueryPlanningIssue[]
  fallbackIssues: readonly ObjectQueryPlanningIssue[]
  issues: readonly ObjectQueryPlanningIssue[]
  fallback?: {
    maxRows: number
    requiresExplicitBound: boolean
  }
}

export interface ObjectQueryPlanningOptions {
  capabilities: ObjectQueryCapabilities
  operation?: ObjectQueryProviderOperation
  hasQueryObjects?: boolean
  hasCountObjects?: boolean
  hasExistsObjects?: boolean
  hasFacetObjects?: boolean
  allowFallback?: boolean
  maxFallbackRows?: number
  requiresExplicitFallbackBound?: boolean
}

const DEFAULT_MAX_FALLBACK_ROWS = 1_000

// Fallback executes over ObjectStorage.list and is intentionally narrower than
// provider pushdown. Complex semantics stay provider-owned and cannot become
// accidental full scans.
const fallbackNodeKinds = new Set<ObjectQuery["kind"]>([
  "start",
  "filter",
  "sort",
  "limit",
  "page",
  "project",
  "expand",
])

export function planObjectQuery(
  query: ObjectQuery,
  options: ObjectQueryPlanningOptions
): ObjectQueryPlan {
  const operation = options.operation ?? "queryObjects"
  // Providers get first refusal. Fallback is considered only after the provider
  // declares that pushdown is unavailable or incomplete for this query.
  const providerIssues = collectProviderIssues(query, options.capabilities, {
    operation,
    hasImplementation: hasProviderImplementation(operation, options),
  })

  if (providerIssues.length === 0) {
    return {
      mode: "pushdown",
      query,
      providerIssues,
      fallbackIssues: [],
      issues: [],
    }
  }

  const fallbackIssues = collectFallbackIssues(query, options)
  const issues = [...providerIssues, ...fallbackIssues]

  if (fallbackIssues.length === 0) {
    return {
      mode: "fallback",
      query,
      providerIssues,
      fallbackIssues,
      issues: [],
      fallback: {
        maxRows: options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS,
        requiresExplicitBound: options.requiresExplicitFallbackBound !== false,
      },
    }
  }

  return {
    mode: "rejected",
    query,
    providerIssues,
    fallbackIssues,
    issues,
  }
}

function collectProviderIssues(
  query: ObjectQuery,
  capabilities: ObjectQueryCapabilities,
  options: { operation: ObjectQueryProviderOperation; hasImplementation: boolean }
): ObjectQueryPlanningIssue[] {
  const issues: ObjectQueryPlanningIssue[] = []

  // Capability maps are allowlists: missing flags mean unsupported.
  collectOperationProviderIssues(capabilities, options, issues)

  collectNodeProviderIssues(query, "$", capabilities, issues)
  return issues
}

function collectOperationProviderIssues(
  capabilities: ObjectQueryCapabilities,
  options: { operation: ObjectQueryProviderOperation; hasImplementation: boolean },
  issues: ObjectQueryPlanningIssue[]
): void {
  const enabled =
    options.operation === "queryObjects"
      ? capabilities.queryObjects === true
      : options.operation === "countObjects"
        ? capabilities.countObjects === true
        : options.operation === "existsObjects"
          ? capabilities.existsObjects === true
          : capabilities.facetObjects === true

  if (!enabled) {
    const code = `${operationIssuePrefix(options.operation)}_not_enabled`
    addIssue(
      issues,
      "$",
      code,
      `Object storage capabilities do not enable ${options.operation} pushdown`
    )
  }

  if (options.hasImplementation) return

  const code = `${operationIssuePrefix(options.operation)}_not_implemented`
  addIssue(issues, "$", code, `Object storage does not implement ${options.operation}`)
}

function hasProviderImplementation(
  operation: ObjectQueryProviderOperation,
  options: ObjectQueryPlanningOptions
): boolean {
  switch (operation) {
    case "queryObjects":
      return options.hasQueryObjects === true
    case "countObjects":
      return options.hasCountObjects === true
    case "existsObjects":
      return options.hasExistsObjects === true
    case "facetObjects":
      return options.hasFacetObjects === true
  }
}

function operationIssuePrefix(operation: ObjectQueryProviderOperation): string {
  switch (operation) {
    case "queryObjects":
      return "query_objects"
    case "countObjects":
      return "count_objects"
    case "existsObjects":
      return "exists_objects"
    case "facetObjects":
      return "facet_objects"
  }
}

function collectNodeProviderIssues(
  query: ObjectQuery,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  if (capabilities.nodes?.[query.kind] !== true) {
    addIssue(
      issues,
      path,
      "query_node_not_supported",
      `Provider does not support query node '${query.kind}'`
    )
  }

  switch (query.kind) {
    case "start":
      if (query.includeSubtypes === true && capabilities.features?.includeSubtypes !== true) {
        addIssue(
          issues,
          path,
          "include_subtypes_not_supported",
          "Provider does not support start.includeSubtypes expansion"
        )
      }
      return
    case "filter":
      collectPredicateProviderIssues(query.predicate, `${path}.predicate`, capabilities, issues)
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "text":
    case "vector":
    case "project":
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "limit":
      collectProviderMaxLimitIssues(query.limit, path, capabilities, issues)
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "page":
      collectProviderMaxPageSizeIssues(query.pageSize, path, capabilities, issues)
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "traverse":
      if (capabilities.traversalDirections?.[query.direction] !== true) {
        addIssue(
          issues,
          path,
          "traversal_direction_not_supported",
          `Provider does not support ${query.direction} traversal`
        )
      }
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "set":
      if (capabilities.setOps?.[query.op] !== true) {
        addIssue(
          issues,
          path,
          "set_operation_not_supported",
          `Provider does not support set operation '${query.op}'`
        )
      }
      query.inputs.forEach((input, index) => {
        collectNodeProviderIssues(input, `${path}.inputs[${index}]`, capabilities, issues)
      })
      return
    case "sort":
      query.fields.forEach((field, index) => {
        collectSortProviderIssues(field, `${path}.fields[${index}]`, capabilities, issues)
      })
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
    case "expand":
      query.expansions.forEach((expansion, index) => {
        collectExpansionProviderIssues(
          expansion,
          `${path}.expansions[${index}]`,
          capabilities,
          issues
        )
      })
      collectNodeProviderIssues(query.input, `${path}.input`, capabilities, issues)
      return
  }
}

// An expansion only pushes down once core has resolved its cardinality; an
// unresolved one (e.g. a polymorphic parent whose branches disagree) keeps the
// whole query on the bounded fallback, which re-derives cardinality per row.
function collectExpansionProviderIssues(
  expansion: ObjectExpansion,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  if (expansion.cardinality === undefined) {
    addIssue(
      issues,
      path,
      "expand_cardinality_unresolved",
      `Provider cannot push down expansion '${expansion.linkId}' without a resolved cardinality`
    )
  }

  expansion.orderBy?.forEach((field, index) => {
    collectSortProviderIssues(field, `${path}.orderBy[${index}]`, capabilities, issues)
  })

  expansion.expand?.forEach((nested, index) => {
    collectExpansionProviderIssues(nested, `${path}.expand[${index}]`, capabilities, issues)
  })
}

function collectPredicateProviderIssues(
  predicate: ObjectQueryPredicate,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  const scalarOperation = predicateScalarOperation(predicate)
  if (
    "scalarKind" in predicate &&
    predicate.scalarKind !== undefined &&
    scalarOperation !== undefined &&
    capabilities.scalarOperations?.[predicate.scalarKind]?.[scalarOperation] !== true
  ) {
    addIssue(
      issues,
      path,
      "scalar_operation_not_supported",
      `Provider does not support ${scalarOperation} for '${predicate.scalarKind}' values`
    )
  }

  if (capabilities.predicateOps?.[predicate.op] !== true) {
    addIssue(
      issues,
      path,
      "predicate_operation_not_supported",
      `Provider does not support predicate operation '${predicate.op}'`
    )
  }

  switch (predicate.op) {
    case "and":
    case "or":
      predicate.items.forEach((item, index) => {
        collectPredicateProviderIssues(item, `${path}.items[${index}]`, capabilities, issues)
      })
      return
    case "not":
      collectPredicateProviderIssues(predicate.item, `${path}.item`, capabilities, issues)
      return
    default:
      return
  }
}

function predicateScalarOperation(
  predicate: ObjectQueryPredicate
): ObjectQueryScalarOperation | undefined {
  switch (predicate.op) {
    case "eq":
    case "neq":
    case "in":
      return "equality"
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return "ordering"
    default:
      return undefined
  }
}

function collectSortProviderIssues(
  field: ObjectQuerySortField,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  if (
    field.kind === "property" &&
    field.scalarKind !== undefined &&
    capabilities.scalarOperations?.[field.scalarKind]?.ordering !== true
  ) {
    addIssue(
      issues,
      path,
      "scalar_operation_not_supported",
      `Provider does not support ordering for '${field.scalarKind}' values`
    )
  }

  if (capabilities.sortKinds?.[field.kind] === true) return
  addIssue(
    issues,
    path,
    "sort_kind_not_supported",
    `Provider does not support sort kind '${field.kind}'`
  )
}

function collectProviderMaxLimitIssues(
  limit: number,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  const maxLimit = capabilities.limits?.maxLimit
  if (maxLimit === undefined) return

  if (!Number.isInteger(maxLimit) || maxLimit < 0) {
    addIssue(
      issues,
      path,
      "invalid_provider_limit_capability",
      "Provider limit capability maxLimit must be a non-negative integer"
    )
    return
  }

  if (limit > maxLimit) {
    addIssue(issues, path, "provider_limit_too_large", `Provider supports limit up to ${maxLimit}`)
  }
}

function collectProviderMaxPageSizeIssues(
  pageSize: number,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  const maxPageSize = capabilities.limits?.maxPageSize
  if (maxPageSize === undefined) return

  if (!Number.isInteger(maxPageSize) || maxPageSize <= 0) {
    addIssue(
      issues,
      path,
      "invalid_provider_page_size_capability",
      "Provider limit capability maxPageSize must be a positive integer"
    )
    return
  }

  if (pageSize > maxPageSize) {
    addIssue(
      issues,
      path,
      "provider_page_size_too_large",
      `Provider supports pageSize up to ${maxPageSize}`
    )
  }
}

function collectFallbackIssues(
  query: ObjectQuery,
  options: ObjectQueryPlanningOptions
): ObjectQueryPlanningIssue[] {
  const issues: ObjectQueryPlanningIssue[] = []

  if (options.allowFallback === false) {
    addIssue(issues, "$", "fallback_disabled", "Object query fallback is disabled")
    return issues
  }

  const maxFallbackRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  if (!Number.isInteger(maxFallbackRows) || maxFallbackRows <= 0) {
    addIssue(issues, "$", "invalid_fallback_bound", "maxFallbackRows must be a positive integer")
  }

  // The result bound protects API callers from unbounded fallback responses.
  // The executor still enforces maxFallbackRows on the source scan separately.
  if (options.requiresExplicitFallbackBound !== false && !hasExplicitResultBound(query)) {
    addIssue(
      issues,
      "$",
      "fallback_requires_bound",
      "Fallback requires an explicit limit or page node"
    )
  }

  collectFallbackNodeIssues(query, "$", issues)
  return issues
}

function collectFallbackNodeIssues(
  query: ObjectQuery,
  path: string,
  issues: ObjectQueryPlanningIssue[]
): void {
  if (!fallbackNodeKinds.has(query.kind)) {
    addIssue(
      issues,
      path,
      "fallback_node_not_supported",
      `Fallback does not support query node '${query.kind}'`
    )
  }

  switch (query.kind) {
    case "start":
      return
    case "filter":
    case "limit":
    case "page":
    case "project":
    case "expand":
      collectFallbackNodeIssues(query.input, `${path}.input`, issues)
      return
    case "sort":
      query.fields.forEach((field, index) => {
        if (field.kind === "relevance") {
          addIssue(
            issues,
            `${path}.fields[${index}]`,
            "fallback_sort_kind_not_supported",
            "Fallback does not support relevance sorting"
          )
        }
      })
      collectFallbackNodeIssues(query.input, `${path}.input`, issues)
      return
    case "text":
    case "vector":
    case "traverse":
      collectFallbackNodeIssues(query.input, `${path}.input`, issues)
      return
    case "set":
      query.inputs.forEach((input, index) => {
        collectFallbackNodeIssues(input, `${path}.inputs[${index}]`, issues)
      })
      return
  }
}

function hasExplicitResultBound(query: ObjectQuery): boolean {
  switch (query.kind) {
    case "limit":
    case "page":
      return true
    case "start":
      return false
    case "set":
      return query.inputs.some(hasExplicitResultBound)
    default:
      return hasExplicitResultBound(query.input)
  }
}

function addIssue(
  issues: ObjectQueryPlanningIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message })
}
