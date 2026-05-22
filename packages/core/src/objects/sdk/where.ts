/**
 * Where-clause builder for typed ObjectSet queries.
 *
 * Provides `createWhereBuilder` (predicate DSL) and `resolveWhere` (evaluator)
 * used by `createObjectSet` for `findFirst` and `list` filtering.
 */
import type { ValueType } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { ObjectWhereBuilder, ObjectWhereClause } from "../../runtime/types"

export type WhereClause = { propertyId: string; op: "eq"; value: unknown }

export function createWhereBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(objectType: TObjectType): ObjectWhereBuilder<TObjectType, TValueTypes> {
  const entries = objectType.properties.map((property) => {
    return [
      property.id,
      {
        eq: (value: unknown) => ({
          propertyId: property.id,
          op: "eq",
          value,
        }),
      },
    ]
  })

  return {
    p: Object.fromEntries(entries),
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
): readonly WhereClause[] | undefined {
  if (!whereFn) return undefined
  const whereBuilder = createWhereBuilder<TObjectType, TValueTypes>(objectType)
  const whereInput = whereFn(whereBuilder)
  if (!whereInput) return undefined
  return (Array.isArray(whereInput) ? whereInput : [whereInput]) as readonly WhereClause[]
}
