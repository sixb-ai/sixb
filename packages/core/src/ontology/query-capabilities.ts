/**
 * Query rules for a schema whose `valueTypeRef`s are already resolved. Registration uses them to
 * accept declared `query` flags, query validation to accept operators, and the ontology API to
 * report both, so the three cannot drift.
 */
import type { QueryScalarKind } from "../objects/query/ir"
import { primitiveTraits } from "./primitives"
import type { Property, Schema, ValueType } from "./types"

/** `eq`/`neq`/`in`/`exists` predicates and `query.exact`. */
export function isExactSchema(schema: Schema): boolean {
  if (typeof schema === "string") return primitiveTraits(schema)?.exact === true
  return schema.type === "enum"
}

/** `query.filterable`: exact matching, or `contains` over a collection. */
export function isFilterableSchema(schema: Schema): boolean {
  return (
    isExactSchema(schema) ||
    (typeof schema !== "string" && (schema.type === "array" || schema.type === "map"))
  )
}

/** Range predicates and `query.sortable`. */
export function isSortableSchema(schema: Schema): boolean {
  if (typeof schema === "string") return primitiveTraits(schema)?.sortable === true
  return schema.type === "enum"
}

/** Keyword search. */
export function isTextSchema(schema: Schema): boolean {
  if (typeof schema === "string") return primitiveTraits(schema)?.text === true
  return schema.type === "enum" && schema.valueType === "string"
}

/** `contains`: substring for scalars, item for arrays, key for maps. */
export function isContainsSchema(schema: Schema): boolean {
  if (typeof schema === "string") return primitiveTraits(schema)?.contains === true
  return schema.type === "array" || schema.type === "map"
}

/** `query.facet`. */
export function isFacetSchema(schema: Schema): boolean {
  if (typeof schema === "string") return primitiveTraits(schema)?.facet === true
  return schema.type === "enum"
}

export function queryScalarKindForSchema(schema: Schema): QueryScalarKind | undefined {
  if (typeof schema === "string") return primitiveTraits(schema)?.queryScalarKind
  if (schema.type === "enum") return schema.valueType === "integer" ? "integer" : "string"
  return undefined
}

/** Predicate operators a property may use in an object query. */
export type PropertyQueryOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "exists"
  | "contains"

/** What an object query can do with one property, resolved from its schema and `query` flags. */
export interface PropertyQueryCapabilities {
  readonly operators: readonly PropertyQueryOperator[]
  readonly sortable: boolean
  readonly facet: boolean
  readonly text: boolean
}

const PRIMARY_OPERATORS: readonly PropertyQueryOperator[] = ["eq", "in"]
const EXACT_OPERATORS: readonly PropertyQueryOperator[] = ["eq", "neq", "in", "exists"]
const RANGE_OPERATORS: readonly PropertyQueryOperator[] = ["lt", "lte", "gt", "gte"]
const OPERATOR_ORDER: readonly PropertyQueryOperator[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
  "exists",
]

/**
 * Resolve what object queries accept for a property, applying the same rules as query validation:
 * primary ids always accept `eq`/`in`; other predicates, sorting, faceting, and keyword search need
 * `query.searchable` plus the matching flag and a schema that supports it.
 */
export function resolvePropertyQueryCapabilities(
  property: Property,
  valueTypesById: ReadonlyMap<string, ValueType>
): PropertyQueryCapabilities {
  const query = property.query?.searchable === true ? property.query : undefined
  const schema = resolveQuerySchema(property.schema, valueTypesById)
  const operators = new Set<PropertyQueryOperator>(property.primary ? PRIMARY_OPERATORS : [])

  if (query?.filterable === true && schema) {
    if (isExactSchema(schema)) for (const op of EXACT_OPERATORS) operators.add(op)
    if (isSortableSchema(schema)) for (const op of RANGE_OPERATORS) operators.add(op)
    if (isContainsSchema(schema)) operators.add("contains")
  }

  return {
    operators: OPERATOR_ORDER.filter((op) => operators.has(op)),
    sortable: query?.sortable === true && schema !== undefined && isSortableSchema(schema),
    facet: query?.facet === true && schema !== undefined && isFacetSchema(schema),
    text:
      query?.text === true &&
      property.mode !== "telemetry" &&
      schema !== undefined &&
      isTextSchema(schema),
  }
}

function resolveQuerySchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seen = new Set<string>()
): Schema | undefined {
  if (typeof schema === "string" || schema.type !== "valueTypeRef") return schema
  if (seen.has(schema.valueTypeId)) return undefined
  seen.add(schema.valueTypeId)
  const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
  return resolved ? resolveQuerySchema(resolved, valueTypesById, seen) : undefined
}
