import type { ObjectType, SchemaOrRef } from "../ontology"
import type { QuantitativeTypeId } from "../ontology/units"
import type {
  ActionBuilder,
  ActionHandler,
  ActionParamConfig,
  ActionParamsConfig,
  ActionValidator,
  GlobalActionHandler,
  GlobalActionValidator,
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
): ActionBuilder<TId> {
  assertNonEmpty(id, "id")

  return createActionBuilder(id, options) as unknown as ActionBuilder<TId>
}

function createActionBuilder(id: string, options?: ActionOptions) {
  const builder = {
    params(params: ActionParamsConfig) {
      const validators: GlobalActionValidator<Record<string, unknown>>[] = []

      const runBuilder = {
        validate(validator: GlobalActionValidator<Record<string, unknown>>) {
          validators.push(validator)
          return runBuilder
        },
        run(handler: GlobalActionHandler<Record<string, unknown>>) {
          return {
            kind: "action",
            id,
            binding: { kind: "global" },
            params,
            validators,
            handler,
            description: options?.description,
          }
        },
      }

      return runBuilder
    },
    on(objectType: ObjectType) {
      assertNonEmpty(objectType.id, "target id")
      return createObjectActionParamsBuilder(id, objectType, options)
    },
    target(objectType: ObjectType) {
      return builder.on(objectType)
    },
  }

  return builder
}

function createObjectActionParamsBuilder(
  id: string,
  objectType: ObjectType,
  options?: ActionOptions
) {
  return {
    params(params: ActionParamsConfig) {
      const validators: ActionValidator<ObjectType, Record<string, unknown>>[] = []

      const runBuilder = {
        validate(validator: ActionValidator<ObjectType, Record<string, unknown>>) {
          validators.push(validator)
          return runBuilder
        },
        run(handler: ActionHandler<ObjectType, Record<string, unknown>>) {
          return {
            kind: "action",
            id,
            binding: { kind: "object", objectType },
            target: objectType,
            params,
            validators,
            handler,
            description: options?.description,
          }
        },
      }

      return runBuilder
    },
  }
}
