import type { FileRef } from "../../blob-storage"
import type { ObjectFieldSchema, Property, Schema, ValueType } from ".."
import type { QuantitativeTypeId, UnitsOf } from "../units"

type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Look up a referenced value type by `id` from the value-type tuple passed
 * into the inference utilities.
 */
type ResolveValueType<
  TValueTypes extends readonly ValueType[],
  TValueTypeId extends string,
> = Extract<TValueTypes[number], { id: TValueTypeId }>

/**
 * Resolve `{ type: "valueTypeRef" }` recursively.
 *
 * Unknown references intentionally degrade to `unknown` so type-level callsites
 * can decide how strict they want to be.
 */
type InferValueTypeRef<TValueTypeId extends string, TValueTypes extends readonly ValueType[]> =
  ResolveValueType<TValueTypes, TValueTypeId> extends infer TValueType
    ? TValueType extends ValueType
      ? InferSchema<TValueType["schema"], TValueTypes>
      : unknown
    : unknown

type RequiredFieldIds<TFields extends Record<string, ObjectFieldSchema>> = {
  [K in keyof TFields]-?: TFields[K]["required"] extends true ? K : never
}[keyof TFields]

type OptionalFieldIds<TFields extends Record<string, ObjectFieldSchema>> = Exclude<
  keyof TFields,
  RequiredFieldIds<TFields>
>

type InferObjectFieldValue<
  TObjectField extends ObjectFieldSchema,
  TValueTypes extends readonly ValueType[],
> = TObjectField["nullable"] extends true
  ? InferSchema<TObjectField["schema"], TValueTypes> | null
  : InferSchema<TObjectField["schema"], TValueTypes>

type InferObjectFields<
  TFields extends Record<string, ObjectFieldSchema>,
  TValueTypes extends readonly ValueType[],
> = Simplify<
  {
    [K in RequiredFieldIds<TFields>]: InferObjectFieldValue<TFields[K], TValueTypes>
  } & {
    [K in OptionalFieldIds<TFields>]?: InferObjectFieldValue<TFields[K], TValueTypes>
  }
>

/**
 * Convert ontology schema definitions into runtime value types.
 *
 * This is the core typing bridge used by the future object SDK APIs.
 */
export type InferSchema<
  TSchema extends Schema,
  TValueTypes extends readonly ValueType[] = [],
> = TSchema extends "fileRef"
  ? FileRef
  : TSchema extends "string"
    ? string
    : TSchema extends "uuid"
      ? string
      : TSchema extends "boolean"
        ? boolean
        : TSchema extends "integer" | "double" | "decimal"
          ? number
          : TSchema extends "date" | "timestamp"
            ? Date | string
            : TSchema extends { type: "enum"; values: readonly (infer TValue)[] }
              ? TValue
              : TSchema extends { type: "array"; items: infer TItems extends Schema }
                ? InferSchema<TItems, TValueTypes>[]
                : TSchema extends {
                      type: "map"
                      keySchema: "string"
                      valueSchema: infer TValueSchema extends Schema
                    }
                  ? Record<string, InferSchema<TValueSchema, TValueTypes>>
                  : TSchema extends {
                        type: "object"
                        properties: infer TFields extends Record<string, ObjectFieldSchema>
                      }
                    ? InferObjectFields<TFields, TValueTypes>
                    : TSchema extends {
                          type: "valueTypeRef"
                          _resolved: infer TResolved extends Schema
                        }
                      ? InferSchema<TResolved, TValueTypes>
                      : TSchema extends {
                            type: "valueTypeRef"
                            valueTypeId: infer TValueTypeId extends string
                          }
                        ? InferValueTypeRef<TValueTypeId, TValueTypes>
                        : never

/** Property-level value inference with nullable support. */
export type InferPropertyValue<
  TProperty extends Pick<Property, "schema" | "nullable">,
  TValueTypes extends readonly ValueType[] = [],
> = TProperty["nullable"] extends true
  ? InferSchema<TProperty["schema"], TValueTypes> | null
  : InferSchema<TProperty["schema"], TValueTypes>

type InferPropertySemanticTypeFromValueTypeRef<
  TProperty extends Pick<Property, "schema">,
  TValueTypes extends readonly ValueType[],
> = TProperty["schema"] extends {
  type: "valueTypeRef"
  valueTypeId: infer TValueTypeId extends string
}
  ? ResolveValueType<TValueTypes, TValueTypeId> extends {
      semanticType: infer TSemanticType extends QuantitativeTypeId
    }
    ? TSemanticType
    : never
  : never

export type InferPropertySemanticType<
  TProperty extends Pick<Property, "schema" | "semanticType">,
  TValueTypes extends readonly ValueType[] = [],
> = TProperty["semanticType"] extends QuantitativeTypeId
  ? TProperty["semanticType"]
  : InferPropertySemanticTypeFromValueTypeRef<TProperty, TValueTypes>

/**
 * Resolve the valid unit-id union for a property.
 *
 * Semantic type can come either directly from the property or indirectly from
 * a referenced value type.
 */
export type InferPropertyUnit<
  TProperty extends Pick<Property, "schema" | "semanticType">,
  TValueTypes extends readonly ValueType[] = [],
> =
  InferPropertySemanticType<TProperty, TValueTypes> extends infer TSemanticType extends
    QuantitativeTypeId
    ? UnitsOf<TSemanticType>
    : never

export type InferObjectProperties<
  TObjectType extends { properties: readonly Property[] },
  TValueTypes extends readonly ValueType[] = [],
> =
  // Object types whose property ids are not statically known (the broad
  // `ObjectTypeWithPropertyTokens` base, e.g. as a generic constraint or
  // after an unresolved link traversal) get an untyped property bag —
  // instantiating the mapped type over the broad `Property` union overflows
  // TypeScript's recursion limits.
  string extends TObjectType["properties"][number]["id"]
    ? Record<string, unknown>
    : // Iterates over the property union directly (via `as TProp["id"]`
      // remapping) so that `TProp` is already resolved — avoids repeated
      // `Extract` lookups per key, which cause TS2589 when consumers relate
      // these types in deep contexts such as `rows.map(...)` callbacks.
      Simplify<
        {
          [TProp in TObjectType["properties"][number] as TProp extends { required: true }
            ? TProp["id"]
            : never]: InferPropertyValue<TProp, TValueTypes>
        } & {
          [TProp in TObjectType["properties"][number] as TProp extends { required: true }
            ? never
            : TProp["id"]]?: InferPropertyValue<TProp, TValueTypes>
        }
      >

/** Useful for APIs that should only accept telemetry-mode properties. */
export type InferTelemetryPropertyIds<TObjectType extends { properties: readonly Property[] }> =
  Extract<TObjectType["properties"][number], { mode: "telemetry" }>["id"]

/**
 * Batch telemetry properties record — all telemetry properties optional with typed values/units.
 *
 * Iterates over the extracted telemetry property union directly (via `as P["id"]` remapping)
 * so that `P` is already resolved — avoids repeated indexed access through the token map
 * which would cause TS2589 on object types with many telemetry properties.
 */
export type InferTelemetryBatchProperties<
  TObjectType extends { properties: readonly Property[] },
  TValueTypes extends readonly ValueType[] = [],
> = {
  [P in Extract<
    TObjectType["properties"][number],
    { mode: "telemetry" }
  > as P["id"]]?: P["semanticType"] extends QuantitativeTypeId
    ? { value: InferPropertyValue<P, TValueTypes>; unit: UnitsOf<P["semanticType"]> }
    : P["schema"] extends { type: "valueTypeRef"; valueTypeId: infer TVtId extends string }
      ? ResolveValueType<TValueTypes, TVtId> extends {
          semanticType: infer TSem extends QuantitativeTypeId
        }
        ? { value: InferPropertyValue<P, TValueTypes>; unit: UnitsOf<TSem> }
        : InferPropertyValue<P, TValueTypes>
      : InferPropertyValue<P, TValueTypes>
}
