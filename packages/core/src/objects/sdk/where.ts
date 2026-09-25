/**
 * Where-clause builder for typed ObjectSet queries.
 *
 * Provides `createWhereBuilder` (predicate DSL) and `resolveWhere` (evaluator).
 * The builder emits object query IR predicates. Property predicates are created
 * on demand through a Proxy, so no runtime ontology access is required —
 * property names are constrained at compile time and validated server-side.
 */
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { ObjectWhereBuilder, ObjectWhereClause } from "../../runtime/types"
import type { ObjectQueryPredicate } from "../query"

function createPropertyPredicate(propertyId: string) {
  const comparison = (op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte") => {
    return (value: unknown) => ({
      propertyId,
      op,
      value,
    })
  }

  return {
    eq: comparison("eq"),
    neq: comparison("neq"),
    lt: comparison("lt"),
    lte: comparison("lte"),
    gt: comparison("gt"),
    gte: comparison("gte"),
    in: (values: readonly unknown[]) => ({
      propertyId,
      op: "in",
      values,
    }),
    exists: (value = true) => ({
      propertyId,
      op: "exists",
      value,
    }),
    contains: (value: unknown) => ({
      propertyId,
      op: "contains",
      value,
    }),
  }
}

export function createWhereBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
>(): ObjectWhereBuilder<TObjectType> {
  const p = new Proxy(
    {},
    {
      get: (_target, propertyId) =>
        typeof propertyId === "string" ? createPropertyPredicate(propertyId) : undefined,
    }
  )

  return {
    p,
    and: (...items: readonly ObjectQueryPredicate[]) => ({ op: "and", items }),
    or: (...items: readonly ObjectQueryPredicate[]) => ({ op: "or", items }),
    not: (item: ObjectQueryPredicate) => ({ op: "not", item }),
  } as ObjectWhereBuilder<TObjectType>
}

export function resolveWhere<TObjectType extends ObjectTypeWithPropertyTokens>(
  whereFn?: (
    builder: ObjectWhereBuilder<TObjectType>
  ) => ObjectWhereClause<TObjectType> | readonly ObjectWhereClause<TObjectType>[]
): ObjectQueryPredicate | undefined {
  if (!whereFn) return undefined
  const whereBuilder = createWhereBuilder<TObjectType>()
  const whereInput = whereFn(whereBuilder)
  if (!whereInput) return undefined
  const predicates = (
    Array.isArray(whereInput) ? whereInput : [whereInput]
  ) as readonly ObjectQueryPredicate[]
  if (predicates.length === 0) return undefined
  return predicates.length === 1 ? predicates[0] : { op: "and", items: predicates }
}
