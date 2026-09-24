import type { DecimalValue, PrimitiveSchema, Property } from "../src"
import { assertNever } from "../src/assert-never"
import type { PrimitiveTraits } from "../src/ontology/primitives"
import type { OrderedPredicateValueFor, PredicateValueFor } from "../src/predicates"

/**
 * A primitive schema must be decided everywhere it matters instead of inheriting string-like
 * behavior. To see every decision site, add a member to `PrimitiveSchema` and run
 * `bun --filter @sixb/core typecheck`: the traits table in `ontology/primitives.ts`, the
 * inference map, JSON Schema, value validation, normalization, workflow snapshots, and the rule
 * predicate values all fail until the new primitive is handled.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const traits: PrimitiveTraits = {
  queryScalarKind: "string",
  exact: true,
  sortable: true,
  text: true,
  contains: true,
  facet: true,
  telemetry: true,
  shareableParam: true,
}

// The traits table uses this constraint: a table without a row for every primitive is rejected.
export const missingRow = {
  string: traits,
  uuid: traits,
  integer: traits,
  double: traits,
  decimal: traits,
  date: traits,
  timestamp: traits,
  boolean: traits,
  // @ts-expect-error fileRef has no row
} satisfies Record<PrimitiveSchema, PrimitiveTraits>

// Per-type switches close with `assertNever` or `satisfies never`: a missing case is rejected.
export function missingCase(schema: PrimitiveSchema): string {
  switch (schema) {
    case "string":
    case "uuid":
    case "integer":
    case "double":
    case "decimal":
    case "date":
    case "timestamp":
    case "boolean":
      return schema
    default:
      // @ts-expect-error fileRef has no case
      return assertNever(schema, "unreachable")
  }
}

type PropertyOf<TSchema extends PrimitiveSchema> = Property & {
  id: "value"
  schema: TSchema
}

export type RulePredicateValues = [
  Expect<Equal<PredicateValueFor<PropertyOf<"string">>, string>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"uuid">>, string>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"date">>, string>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"timestamp">>, string>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"integer">>, number>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"double">>, number>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"decimal">>, DecimalValue>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"boolean">>, boolean>>,
  Expect<Equal<PredicateValueFor<PropertyOf<"fileRef">>, never>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"integer">>, number>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"double">>, number>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"decimal">>, DecimalValue>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"string">>, never>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"timestamp">>, never>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"boolean">>, never>>,
  Expect<Equal<OrderedPredicateValueFor<PropertyOf<"fileRef">>, never>>,
]
