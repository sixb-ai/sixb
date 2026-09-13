import type { SchemaOrRef } from "../../ontology"
import type { QuantitativeTypeId } from "../../ontology/units"
import type { ParamConfig } from "./types"

export interface ParamOptions {
  readonly description?: string
  readonly semanticType?: QuantitativeTypeId
  readonly nullable?: boolean
}

type FieldFromOptions<TOptions, TKey extends string, TFallback> =
  TOptions extends Record<TKey, infer TValue>
    ? { [K in TKey]: TValue }
    : { [K in TKey]?: TFallback }

type ParamResult<
  TSchema extends SchemaOrRef,
  TRequired extends boolean,
  TOptions extends ParamOptions | undefined,
> = {
  schema: TSchema
  required: TRequired
} & FieldFromOptions<TOptions, "description", string> &
  FieldFromOptions<TOptions, "semanticType", QuantitativeTypeId> &
  FieldFromOptions<TOptions, "nullable", boolean>

/** Declare one required parameter. */
export function param<
  const TSchema extends SchemaOrRef,
  const TOptions extends ParamOptions | undefined = undefined,
>(schema: TSchema, options?: TOptions): ParamResult<TSchema, true, TOptions> {
  const result: ParamConfig & { required: true } = {
    schema,
    required: true,
    ...(options?.description !== undefined ? { description: options.description } : {}),
    ...(options?.semanticType !== undefined ? { semanticType: options.semanticType } : {}),
    ...(options?.nullable !== undefined ? { nullable: options.nullable } : {}),
  }
  return result as ParamResult<TSchema, true, TOptions>
}

/** Derive an optional parameter without changing its schema or metadata. */
export function optional<const TParam extends ParamConfig>(
  paramConfig: TParam
): Omit<TParam, "required"> & { readonly required: false } {
  return {
    ...paramConfig,
    required: false,
  }
}
