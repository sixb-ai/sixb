import type { SchemaOrRef } from "../../ontology"
import type { QuantitativeTypeId } from "../../ontology/units"
import type { ActionParamConfig } from "../types"

type ActionParamOptions = {
  description?: string
  semanticType?: QuantitativeTypeId
}

type ActionParamResult<TSchema extends SchemaOrRef, TRequired extends boolean> = {
  schema: TSchema
  required: TRequired
  description?: string
  semanticType?: QuantitativeTypeId
}

export function param<const TSchema extends SchemaOrRef>(
  schema: TSchema,
  options?: ActionParamOptions
): ActionParamResult<TSchema, true> {
  return {
    schema,
    required: true,
    ...(options?.description !== undefined ? { description: options.description } : {}),
    ...(options?.semanticType !== undefined ? { semanticType: options.semanticType } : {}),
  }
}

export function optional<const TParam extends ActionParamConfig>(
  paramConfig: TParam
): Omit<TParam, "required"> & { readonly required: false } {
  return {
    ...paramConfig,
    required: false,
  }
}
