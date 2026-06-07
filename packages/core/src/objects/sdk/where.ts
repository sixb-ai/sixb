/**
 * Where-clause builder for typed ObjectSet queries.
 *
 * Provides `createWhereBuilder` (predicate DSL) and `resolveWhere` (evaluator).
 * The builder emits object query IR predicates.
 */
import type { ValueType } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { ObjectWhereBuilder, ObjectWhereClause } from "../../runtime/types"
import type { ObjectQueryPredicate } from "../query"

export function createWhereBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(objectType: TObjectType): ObjectWhereBuilder<TObjectType, TValueTypes> {
  const comparison = (propertyId: string, op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte") => {
    return (value: unknown) => ({
      propertyId,
      op,
      value,
    })
  }

  const entries = objectType.properties.map((property) => {
    return [
      property.id,
      {
        eq: comparison(property.id, "eq"),
        neq: comparison(property.id, "neq"),
        lt: comparison(property.id, "lt"),
        lte: comparison(property.id, "lte"),
        gt: comparison(property.id, "gt"),
        gte: comparison(property.id, "gte"),
        in: (values: readonly unknown[]) => ({
          propertyId: property.id,
          op: "in",
          values,
        }),
        exists: (value = true) => ({
          propertyId: property.id,
          op: "exists",
          value,
        }),
        contains: (value: unknown) => ({
          propertyId: property.id,
          op: "contains",
          value,
        }),
      },
    ]
  })

  return {
    p: Object.fromEntries(entries),
    and: (...items: readonly ObjectQueryPredicate[]) => ({ op: "and", items }),
    or: (...items: readonly ObjectQueryPredicate[]) => ({ op: "or", items }),
    not: (item: ObjectQueryPredicate) => ({ op: "not", item }),
  } as ObjectWhereBuilder<TObjectType, TValueTypes>
}

export function resolveWhere<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(
  objectType: TObjectType,
  whereFn?: (
    builder: ObjectWhereBuilder<TObjectType, TValueTypes>
  ) =>
    | ObjectWhereClause<TObjectType, TValueTypes>
    | readonly ObjectWhereClause<TObjectType, TValueTypes>[]
): ObjectQueryPredicate | undefined {
  if (!whereFn) return undefined
  const whereBuilder = createWhereBuilder<TObjectType, TValueTypes>(objectType)
  const whereInput = whereFn(whereBuilder)
  if (!whereInput) return undefined
  const predicates = (
    Array.isArray(whereInput) ? whereInput : [whereInput]
  ) as readonly ObjectQueryPredicate[]
  if (predicates.length === 0) return undefined
  return predicates.length === 1 ? predicates[0] : { op: "and", items: predicates }
}
