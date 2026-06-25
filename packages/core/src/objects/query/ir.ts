/**
 * Provider-neutral object query IR.
 *
 * The IR describes the requested object-set operation without committing to a
 * storage backend. Providers can push down the subset they support, while the
 * core planner decides whether a bounded fallback is acceptable.
 */
export type ObjectQueryDirection = "outgoing" | "incoming"
export type ObjectQuerySetOperation = "union" | "intersect" | "subtract"
export type ObjectQuerySortDirection = "asc" | "desc"

export type ObjectQuery =
  | ObjectQueryStart
  | ObjectQueryFilter
  | ObjectQueryText
  | ObjectQueryVector
  | ObjectQueryTraverse
  | ObjectQuerySet
  | ObjectQuerySort
  | ObjectQueryLimit
  | ObjectQueryPage
  | ObjectQueryProject
  | ObjectQueryExpand

export interface ObjectQueryStart {
  kind: "start"
  objectTypeId: string
  includeSubtypes?: boolean
}

export interface ObjectQueryFilter {
  kind: "filter"
  input: ObjectQuery
  predicate: ObjectQueryPredicate
}

export interface ObjectQueryText {
  kind: "text"
  input: ObjectQuery
  query: string
  fields?: readonly string[]
  /**
   * Resolved search-profile defaults, keyed by object type id.
   *
   * Providers receive this from core validation when `fields` is omitted so
   * multi-type text queries do not leak one type's defaults onto another.
   */
  fieldsByObjectType?: Readonly<Record<string, readonly string[]>>
}

export interface ObjectQueryVector {
  kind: "vector"
  input: ObjectQuery
  vector: readonly number[]
  propertyId: string
  k: number
}

export interface ObjectQueryTraverse {
  kind: "traverse"
  input: ObjectQuery
  linkId: string
  direction: ObjectQueryDirection
  /**
   * Constrains incoming traversal to one source object type. Without it,
   * incoming traversal matches every object type that declares a link with
   * this `linkId` targeting the input set. The fluent builder always sets it
   * from the link token's owner type.
   */
  sourceObjectTypeId?: string
}

export interface ObjectQuerySet {
  kind: "set"
  op: ObjectQuerySetOperation
  inputs: readonly ObjectQuery[]
}

export interface ObjectQuerySort {
  kind: "sort"
  input: ObjectQuery
  fields: readonly ObjectQuerySortField[]
}

export interface ObjectQueryLimit {
  kind: "limit"
  input: ObjectQuery
  limit: number
}

export interface ObjectQueryPage {
  kind: "page"
  input: ObjectQuery
  pageSize: number
  pageToken?: string
}

export interface ObjectQueryProject {
  kind: "project"
  input: ObjectQuery
  properties?: readonly string[]
}

/**
 * Attaches linked objects to the result set without changing which objects
 * match — the graph-read counterpart to `traverse` (which replaces the set).
 *
 * Like `project`, `expand` is output-shaping: it is normalized to the
 * outermost layer, and `count`/`exists` ignore it. Each {@link ObjectExpansion}
 * names a link to hydrate; nesting walks further hops.
 */
export interface ObjectQueryExpand {
  kind: "expand"
  input: ObjectQuery
  expansions: readonly ObjectExpansion[]
}

export interface ObjectExpansion {
  linkId: string
  /** Defaults to "outgoing". Incoming reuses `sourceObjectTypeId` to disambiguate, like traverse. */
  direction: ObjectQueryDirection
  /** Constrains an incoming expansion to one source object type (see traverse). */
  sourceObjectTypeId?: string
  /** Bounds a "many" expansion to the top-N links per parent. */
  limit?: number
  /** Deterministic ordering for a bounded "many" expansion, against the target type. */
  orderBy?: readonly ObjectQuerySortField[]
  /** Nested expansions, hydrated from the target objects of this expansion. */
  expand?: readonly ObjectExpansion[]
}

export type ObjectQueryPredicate =
  | ObjectQueryPredicateGroup
  | ObjectQueryPredicateNot
  | ObjectQueryPredicateComparison
  | ObjectQueryPredicateIn
  | ObjectQueryPredicateExists
  | ObjectQueryPredicateContains

export interface ObjectQueryPredicateGroup {
  op: "and" | "or"
  items: readonly ObjectQueryPredicate[]
}

export interface ObjectQueryPredicateNot {
  op: "not"
  item: ObjectQueryPredicate
}

export interface ObjectQueryPredicateComparison {
  op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
  propertyId: string
  value: unknown
}

export interface ObjectQueryPredicateIn {
  op: "in"
  propertyId: string
  values: readonly unknown[]
}

export interface ObjectQueryPredicateExists {
  op: "exists"
  propertyId: string
  value: boolean
}

export interface ObjectQueryPredicateContains {
  op: "contains"
  propertyId: string
  value: unknown
}

export type ObjectQuerySortField =
  | { kind: "property"; propertyId: string; direction?: ObjectQuerySortDirection }
  | { kind: "relevance"; direction?: ObjectQuerySortDirection }

export interface ObjectQueryResultShape {
  objectTypeIds: readonly string[]
}
