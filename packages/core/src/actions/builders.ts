import type { ObjectType, SchemaOrRef } from "../ontology"
import type { QuantitativeTypeId } from "../ontology/units"
import type {
  ActionHandler,
  ActionParamConfig,
  ActionParamsConfig,
  ActionTargetBuilder,
  ActionValidator,
} from "./types"
import { assertNonEmpty } from "./validation"

type ActionParamOptions = {
  description?: string
  required?: boolean
  semanticType?: QuantitativeTypeId
}

type ActionOptions = {
  description?: string
}

/**
 * Forces `TRequired` to be a literal `true` or `false` at the call site.
 *
 * If the caller extracts options to a non-`as const` variable (e.g.
 * `const opts = { required: true }`), TypeScript widens `required` to
 * `boolean`, which would silently downgrade the param to optional inside
 * `InferActionParams`. Mapping `boolean` to `never` here turns that silent
 * degradation into a loud type error so the user has to add `as const` or
 * pass options inline.
 */
type StrictBoolean<T extends boolean> = boolean extends T ? never : T

type ActionParamResult<TSchema extends SchemaOrRef, TRequired extends boolean> = {
  schema: TSchema
  required: TRequired
  description?: string
  semanticType?: QuantitativeTypeId
}

export function actionParam<const TSchema extends SchemaOrRef>(
  schema: TSchema
): ActionParamResult<TSchema, false>
export function actionParam<
  const TSchema extends SchemaOrRef,
  const TRequired extends boolean = false,
>(
  schema: TSchema,
  options: {
    required?: StrictBoolean<TRequired>
    description?: string
    semanticType?: QuantitativeTypeId
  }
): ActionParamResult<TSchema, TRequired>
export function actionParam(schema: SchemaOrRef, options?: ActionParamOptions): ActionParamConfig {
  return {
    schema,
    required: options?.required ?? false,
    ...(options?.description !== undefined ? { description: options.description } : {}),
    ...(options?.semanticType !== undefined ? { semanticType: options.semanticType } : {}),
  }
}

export function defineAction<const TId extends string>(
  id: TId,
  options?: ActionOptions
): ActionTargetBuilder<TId> {
  assertNonEmpty(id, "id")

  return createActionBuilder(id, options) as unknown as ActionTargetBuilder<TId>
}

function createActionBuilder(id: string, options?: ActionOptions) {
  return {
    target(objectType: ObjectType) {
      assertNonEmpty(objectType.id, "target id")

      return {
        params(params: ActionParamsConfig) {
          const validators: ActionValidator<ObjectType, Record<string, unknown>>[] = []

          const builder = {
            validate(validator: ActionValidator<ObjectType, Record<string, unknown>>) {
              validators.push(validator)
              return builder
            },
            run(handler: ActionHandler<ObjectType, Record<string, unknown>>) {
              return {
                kind: "action",
                id,
                target: objectType,
                params,
                validators,
                handler,
                description: options?.description,
              }
            },
          }

          return builder
        },
      }
    },
  }
}
