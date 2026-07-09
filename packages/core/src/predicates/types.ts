export type Predicate =
  | AllPredicate
  | AnyPredicate
  | NotPredicate
  | PropertyPredicate
  | FieldPredicate
  | LinkPredicate

export interface AllPredicate {
  readonly kind: "all"
  readonly predicates: readonly Predicate[]
}

export interface AnyPredicate {
  readonly kind: "any"
  readonly predicates: readonly Predicate[]
}

export interface NotPredicate {
  readonly kind: "not"
  readonly predicate: Predicate
}

export type PropertyPredicateOperator =
  | "eq"
  | "notEq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isPresent"
  | "isMissing"

export interface PropertyPredicate {
  readonly kind: "property"
  readonly propertyId: string
  readonly op: PropertyPredicateOperator
  readonly value?: PredicateValue
}

export interface FieldPredicate {
  readonly kind: "field"
  readonly field: string
  readonly op: "eq"
  readonly value: PredicateValue
}

export type LinkPredicateOperator = "exists" | "isMissing"

export interface LinkPredicate {
  readonly kind: "link"
  readonly linkId: string
  readonly op: LinkPredicateOperator
}

export type PredicateValue = string | number | boolean | null

export interface PropertyPredicateBuilder<_TProperty = unknown> {
  eq(value: PredicateValue): PropertyPredicate
  notEq(value: PredicateValue): PropertyPredicate
  gt(value: number): PropertyPredicate
  gte(value: number): PropertyPredicate
  lt(value: number): PropertyPredicate
  lte(value: number): PropertyPredicate
  isPresent(): PropertyPredicate
  isMissing(): PropertyPredicate
}

export interface LinkPredicateBuilder<_TLink = unknown> {
  exists(): LinkPredicate
  isMissing(): LinkPredicate
}
