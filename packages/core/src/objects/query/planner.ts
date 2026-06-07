import type { ObjectQueryCapabilities } from "../../storage"
import type { ObjectQueryPlanningIssue } from "./errors"
import type { ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "./ir"

export type ObjectQueryPlanMode = "pushdown" | "fallback" | "rejected"

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
  hasQueryObjects?: boolean
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
])

export class QueryPlanner {
  plan(query: ObjectQuery, options: ObjectQueryPlanningOptions): ObjectQueryPlan {
    return planObjectQuery(query, options)
  }
}

export function planObjectQuery(
  query: ObjectQuery,
  options: ObjectQueryPlanningOptions
): ObjectQueryPlan {
  // Providers get first refusal. Fallback is considered only after the provider
  // declares that pushdown is unavailable or incomplete for this query.
  const providerIssues = collectProviderIssues(query, options.capabilities, {
    hasQueryObjects: options.hasQueryObjects === true,
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
  options: { hasQueryObjects: boolean }
): ObjectQueryPlanningIssue[] {
  const issues: ObjectQueryPlanningIssue[] = []

  // Capability maps are allowlists: missing flags mean unsupported.
  if (capabilities.queryObjects !== true) {
    addIssue(
      issues,
      "$",
      "query_objects_not_enabled",
      "Object storage capabilities do not enable queryObjects pushdown"
    )
  }

  if (!options.hasQueryObjects) {
    addIssue(
      issues,
      "$",
      "query_objects_not_implemented",
      "Object storage does not implement queryObjects"
    )
  }

  collectNodeProviderIssues(query, "$", capabilities, issues)
  return issues
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
    case "limit":
    case "page":
    case "project":
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
  }
}

function collectPredicateProviderIssues(
  predicate: ObjectQueryPredicate,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
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

function collectSortProviderIssues(
  field: ObjectQuerySortField,
  path: string,
  capabilities: ObjectQueryCapabilities,
  issues: ObjectQueryPlanningIssue[]
): void {
  if (capabilities.sortKinds?.[field.kind] === true) return
  addIssue(
    issues,
    path,
    "sort_kind_not_supported",
    `Provider does not support sort kind '${field.kind}'`
  )
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
