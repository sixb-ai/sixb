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
