import type {
  InferSchemaOrRef,
  ObjectRef,
  ObjectRefSchema,
  SchemaOrRef,
  ValueType,
} from "../../ontology"
import type { QuantitativeTypeId } from "../../ontology/units"

type Simplify<T> = { [K in keyof T]: T[K] } & {}

export interface ActionParamConfig {
  readonly schema: SchemaOrRef
  readonly required?: boolean
  readonly description?: string
  readonly semanticType?: QuantitativeTypeId
}

export type ActionParamsConfig = Record<string, ActionParamConfig>

type RequiredParamKeys<TParams extends ActionParamsConfig> = {
  [K in keyof TParams]-?: TParams[K]["required"] extends true ? K : never
}[keyof TParams]

type OptionalParamKeys<TParams extends ActionParamsConfig> = Exclude<
  keyof TParams,
  RequiredParamKeys<TParams>
>

/**
 * Action params normalize "date" / "timestamp" schemas to `Date` (the wider
 * `InferSchema` form returns `Date | string` to keep storage layers permissive).
 * Handlers see the validated value, so narrowing to `Date` is sound here.
 */
export type ActionPrimitiveSchemaValues = {
  string: string
  uuid: string
  boolean: boolean
  integer: number
  double: number
  decimal: number
  date: Date
  timestamp: Date
}

type InferActionStructuredParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[],
> = TSchema extends { type: "enum"; values: readonly (infer TValue)[] }
  ? TValue
  : TSchema extends ObjectRefSchema<infer TObjectTypeId>
    ? ObjectRef<TObjectTypeId>
    : InferSchemaOrRef<TSchema, TValueTypes>

type InferActionParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[] = [],
> = TSchema extends keyof ActionPrimitiveSchemaValues
  ? ActionPrimitiveSchemaValues[TSchema]
  : InferActionStructuredParamValue<TSchema, TValueTypes>

export type InferActionParams<
  TParams extends ActionParamsConfig,
  TValueTypes extends readonly ValueType[] = [],
> = string extends keyof TParams
  ? Record<string, unknown>
  : Simplify<
      {
        [K in RequiredParamKeys<TParams>]: InferActionParamValue<TParams[K]["schema"], TValueTypes>
      } & {
        [K in OptionalParamKeys<TParams>]?: InferActionParamValue<TParams[K]["schema"], TValueTypes>
      }
    >
