import type { DecimalValue } from "../ontology/decimal"
import type { Property, Schema } from "../ontology/types"

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

/** Serializable equality value inferred from a concrete ontology property. */
export type PredicateValueFor<TProperty extends Property> = string extends TProperty["id"]
  ? PredicateValue
  : TProperty["nullable"] extends true
    ? SerializableSchemaPredicateValue<TProperty["schema"]> | null
    : SerializableSchemaPredicateValue<TProperty["schema"]>

type SerializableSchemaPredicateValue<TSchema extends Schema> = TSchema extends
  | "string"
  | "uuid"
  | "date"
  | "timestamp"
  ? string
  : TSchema extends "integer" | "double"
    ? number
    : TSchema extends "decimal"
      ? DecimalValue
      : TSchema extends "boolean"
        ? boolean
        : TSchema extends { readonly type: "enum"; readonly values: readonly (infer TValue)[] }
          ? Extract<TValue, PredicateValue>
          : TSchema extends {
                readonly type: "valueTypeRef"
                readonly _resolved: infer TResolved extends Schema
              }
            ? SerializableSchemaPredicateValue<TResolved>
            : never

type OrderedSchemaPredicateValue<TSchema extends Schema> = TSchema extends "decimal"
  ? DecimalValue
  : TSchema extends "integer" | "double"
    ? number
    : TSchema extends { readonly type: "enum"; readonly valueType: "integer" }
      ? number
      : TSchema extends {
            readonly type: "valueTypeRef"
            readonly _resolved: infer TResolved extends Schema
          }
        ? OrderedSchemaPredicateValue<TResolved>
        : never

/** Ordered comparison value inferred from a concrete numeric ontology property. */
export type OrderedPredicateValueFor<TProperty extends Property> = string extends TProperty["id"]
  ? number | DecimalValue
  : OrderedSchemaPredicateValue<TProperty["schema"]>

export interface PropertyPredicateBuilder<
  TProperty extends Property = Property,
  TResult = PropertyPredicate,
> {
  eq(value: PredicateValueFor<TProperty>): TResult
  notEq(value: PredicateValueFor<TProperty>): TResult
  gt(value: OrderedPredicateValueFor<TProperty>): TResult
  gte(value: OrderedPredicateValueFor<TProperty>): TResult
  lt(value: OrderedPredicateValueFor<TProperty>): TResult
  lte(value: OrderedPredicateValueFor<TProperty>): TResult
  isPresent(): TResult
  isMissing(): TResult
}

export interface LinkPredicateBuilder<_TLink = unknown> {
  exists(): LinkPredicate
  isMissing(): LinkPredicate
}
