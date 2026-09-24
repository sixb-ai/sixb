import type { QueryScalarKind } from "../objects/query/ir"
import type { PrimitiveSchema } from "./types"

/**
 * Yes/no decisions a primitive schema makes for rules that several modules share.
 *
 * Every primitive states every decision: adding one to `PrimitiveSchema` fails to compile until it
 * has a row here, instead of inheriting string-like behavior from a denylist. Per-type behavior
 * (value validation, normalization, JSON Schema, inference) stays in exhaustive switches next to
 * the code that performs it.
 */
export interface PrimitiveTraits {
  /** Scalar kind object queries compare values with; `undefined` when values are not comparable. */
  readonly queryScalarKind: QueryScalarKind | undefined
  /** Exact matching: `eq`/`neq`/`in`/`exists` predicates and `query.filterable`. */
  readonly exact: boolean
  /** Exact-match search profile: `query.exact` and `search.exact`, matched against search input. */
  readonly exactSearch: boolean
  /** Ordering: range predicates and `query.sortable`. */
  readonly sortable: boolean
  /** Keyword search: `query.text`, search titles, and vector sources. */
  readonly text: boolean
  /** Substring `contains` predicates. */
  readonly contains: boolean
  /** Facet buckets: `query.facet`. */
  readonly facet: boolean
  /** Allowed anywhere inside a telemetry property's schema. */
  readonly telemetry: boolean
  /** Allowed anywhere inside a shared Action parameter's schema. */
  readonly shareableParam: boolean
}

const comparable = {
  exact: true,
  exactSearch: true,
  sortable: true,
  text: false,
  contains: false,
  facet: true,
  telemetry: true,
  shareableParam: true,
} as const

const PRIMITIVE_TRAITS = {
  string: { ...comparable, queryScalarKind: "string", text: true, contains: true },
  uuid: { ...comparable, queryScalarKind: "uuid", contains: true },
  integer: { ...comparable, queryScalarKind: "integer" },
  double: { ...comparable, queryScalarKind: "double" },
  decimal: { ...comparable, queryScalarKind: "decimal" },
  date: { ...comparable, queryScalarKind: "date" },
  timestamp: { ...comparable, queryScalarKind: "timestamp" },
  boolean: { ...comparable, queryScalarKind: "boolean", sortable: false },
  // Blob references are resolved through the object that holds them, never compared.
  fileRef: {
    queryScalarKind: undefined,
    exact: false,
    exactSearch: false,
    sortable: false,
    text: false,
    contains: false,
    facet: false,
    telemetry: false,
    shareableParam: false,
  },
  // User references match by identity, never against typed search input. They are not text, carry
  // no order, and stay out of telemetry and shared sessions, which cannot disclose who they point to.
  userRef: {
    queryScalarKind: "userRef",
    exact: true,
    exactSearch: false,
    sortable: false,
    text: false,
    contains: false,
    facet: true,
    telemetry: false,
    shareableParam: false,
  },
} as const satisfies Record<PrimitiveSchema, PrimitiveTraits>

export function isPrimitiveSchema(schema: unknown): schema is PrimitiveSchema {
  return typeof schema === "string" && Object.hasOwn(PRIMITIVE_TRAITS, schema)
}

/**
 * Traits for a primitive schema. Property schemas are not shape-validated at registration, so an
 * untyped definition can still carry a string outside `PrimitiveSchema`: it gets `undefined`, and
 * callers treat it as supporting no query feature.
 */
export function primitiveTraits(schema: PrimitiveSchema): PrimitiveTraits | undefined {
  return isPrimitiveSchema(schema) ? PRIMITIVE_TRAITS[schema] : undefined
}
