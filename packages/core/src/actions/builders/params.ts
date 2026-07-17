import type { SchemaOrRef } from "../../ontology"
import type { QuantitativeTypeId } from "../../ontology/units"
import type { ActionParamConfig } from "../types"

type ActionParamOptions = {
  description?: string
  semanticType?: QuantitativeTypeId
  nullable?: boolean
}

type FieldFromOptions<TOptions, TKey extends string, TFallback> =
  TOptions extends Record<TKey, infer TValue>
    ? { [K in TKey]: TValue }
    : { [K in TKey]?: TFallback }

type ActionParamResult<
  TSchema extends SchemaOrRef,
  TRequired extends boolean,
  TOptions extends ActionParamOptions | undefined,
> = {
  schema: TSchema
  required: TRequired
} & FieldFromOptions<TOptions, "description", string> &
  FieldFromOptions<TOptions, "semanticType", QuantitativeTypeId> &
  FieldFromOptions<TOptions, "nullable", boolean>

export function param<
  const TSchema extends SchemaOrRef,
  const TOptions extends ActionParamOptions | undefined = undefined,
>(schema: TSchema, options?: TOptions): ActionParamResult<TSchema, true, TOptions> {
  const result: ActionParamConfig & { required: true } = {
    schema,
    required: true,
    ...(options?.description !== undefined ? { description: options.description } : {}),
    ...(options?.semanticType !== undefined ? { semanticType: options.semanticType } : {}),
    ...(options?.nullable !== undefined ? { nullable: options.nullable } : {}),
  }
  return result as ActionParamResult<TSchema, true, TOptions>
}

export function optional<const TParam extends ActionParamConfig>(
  paramConfig: TParam
): Omit<TParam, "required"> & { readonly required: false } {
  return {
    ...paramConfig,
    required: false,
  }
}
