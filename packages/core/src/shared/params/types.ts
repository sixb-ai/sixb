import type {
  DecimalValue,
  InferSchemaOrRef,
  ObjectRef,
  ObjectRefSchema,
  SchemaOrRef,
  ValueType,
} from "../../ontology"
import type { RegisteredValueTypes } from "../../ontology/registered"
import type { QuantitativeTypeId } from "../../ontology/units"

type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** One declarative parameter accepted by a Sixb definition. */
export interface ParamConfig {
  readonly schema: SchemaOrRef
  readonly required?: boolean
  readonly nullable?: boolean
  readonly description?: string
  readonly semanticType?: QuantitativeTypeId
}

/** Parameter shape shared by definitions that accept validated invocation-time input. */
export type ParamsConfig = Record<string, ParamConfig>

type RequiredParamKeys<TParams extends ParamsConfig> = {
  [K in keyof TParams]-?: TParams[K]["required"] extends true ? K : never
}[keyof TParams]

type OptionalParamKeys<TParams extends ParamsConfig> = Exclude<
  keyof TParams,
  RequiredParamKeys<TParams>
>

/**
 * Validated params normalize `date` and `timestamp` values back to `Date` for typed runtime
 * consumers. The wider ontology inference keeps storage-facing values permissive.
 */
export type ParamPrimitiveSchemaValues = {
  string: string
  uuid: string
  boolean: boolean
  integer: number
  double: number
  decimal: DecimalValue
  date: Date
  timestamp: Date
}

type InferStructuredParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[],
> = TSchema extends { type: "enum"; values: readonly (infer TValue)[] }
  ? TValue
  : TSchema extends ObjectRefSchema<infer TObjectTypeId>
    ? ObjectRef<TObjectTypeId>
    : InferSchemaOrRef<TSchema, TValueTypes>

type InferParamSchemaValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[] = RegisteredValueTypes,
> = TSchema extends keyof ParamPrimitiveSchemaValues
  ? ParamPrimitiveSchemaValues[TSchema]
  : InferStructuredParamValue<TSchema, TValueTypes>

type InferParamValue<
  TParam extends ParamConfig,
  TValueTypes extends readonly ValueType[] = RegisteredValueTypes,
> = TParam["nullable"] extends true
  ? InferParamSchemaValue<TParam["schema"], TValueTypes> | null
  : InferParamSchemaValue<TParam["schema"], TValueTypes>

/** Infer the validated runtime input represented by a parameter config. */
export type InferParams<
  TParams extends ParamsConfig,
  TValueTypes extends readonly ValueType[] = RegisteredValueTypes,
> = string extends keyof TParams
  ? Record<string, unknown>
  : Simplify<
      {
        [K in RequiredParamKeys<TParams>]: InferParamValue<TParams[K], TValueTypes>
      } & {
        [K in OptionalParamKeys<TParams>]?: InferParamValue<TParams[K], TValueTypes>
      }
    >
