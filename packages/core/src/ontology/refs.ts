import { OntologyValidationError } from "./errors"
import type { InferSchema } from "./inference"
import type { RegisteredValueTypes } from "./registered"
import type { ObjectType, Schema, ValueType } from "./types"
import { isRecord, validateSchemaValue } from "./validation"

export type ObjectRef<TObjectTypeId extends string = string> = {
  objectTypeId: TObjectTypeId
  primaryId: string
}

export interface ObjectRefSchema<TObjectTypeId extends string = string> {
  readonly type: "objectRef"
  readonly objectTypeId: TObjectTypeId
}

export type SchemaOrRef = Schema | ObjectRefSchema

export type InferSchemaOrRef<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[] = RegisteredValueTypes,
> =
  TSchema extends ObjectRefSchema<infer TObjectTypeId>
    ? ObjectRef<TObjectTypeId>
    : TSchema extends Schema
      ? InferSchema<TSchema, TValueTypes>
      : never

interface RefBuilder {
  /**
   * Reference to one object of `objectType`, for Action and Workflow parameters.
   *
   * Object properties point at other objects with `link(...)` instead: a link is traversable,
   * queryable from both ends, and kept consistent when its target is deleted.
   */
  <const TObjectType extends ObjectType>(
    objectType: TObjectType
  ): ObjectRefSchema<TObjectType["id"]>
  /** Reference to a Sixb user, valued `{ type: "user", id }`. Serialized as `"userRef"`. */
  user(): "userRef"
  /** Reference to a stored file, valued as a `FileRef`. Serialized as `"fileRef"`. */
  file(): "fileRef"
}

/**
 * Schemas that point outside the value itself.
 *
 * Scalars are plain strings (`"string"`, `"timestamp"`); anything that points elsewhere or takes
 * parameters is a builder: `ref(Customer)`, `ref.user()`, `ref.file()`.
 */
export const ref: RefBuilder = Object.assign(
  <const TObjectType extends ObjectType>(
    objectType: TObjectType
  ): ObjectRefSchema<TObjectType["id"]> => ({
    type: "objectRef",
    objectTypeId: objectType.id,
  }),
  {
    user: (): "userRef" => "userRef",
    file: (): "fileRef" => "fileRef",
  }
)

/** Build an exact, typed reference to one object instance. */
export function objectRef<const TObjectType extends ObjectType>(
  objectType: TObjectType,
  primaryId: string
): ObjectRef<TObjectType["id"]> {
  if (
    typeof objectType !== "object" ||
    objectType === null ||
    typeof objectType.id !== "string" ||
    !objectType.id.trim()
  ) {
    throw new OntologyValidationError("[Sixb] Object reference type must be an object type.")
  }
  if (typeof primaryId !== "string" || !primaryId.trim()) {
    throw new OntologyValidationError("[Sixb] Object reference primary id must not be empty.")
  }
  return Object.freeze({ objectTypeId: objectType.id, primaryId })
}

export function isObjectRefSchema(schema: SchemaOrRef): schema is ObjectRefSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { type?: unknown }).type === "objectRef"
  )
}

export function validateSchemaOrRefValue(
  schema: SchemaOrRef,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  if (isObjectRefSchema(schema)) {
    validateObjectRefValue(schema, value, path)
    return
  }

  validateSchemaValue(schema, value, path, valueTypesById)
}

function validateObjectRefValue(schema: ObjectRefSchema, value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be an objectRef`)
  }

  const allowedFields = new Set(["objectTypeId", "primaryId"])
  for (const fieldId of Object.keys(value)) {
    if (!allowedFields.has(fieldId)) {
      throw new OntologyValidationError(`[Sixb] Unknown field '${path}.${fieldId}'`)
    }
  }

  if (value.objectTypeId !== schema.objectTypeId) {
    throw new OntologyValidationError(
      `[Sixb] Property ${path}.objectTypeId must be "${schema.objectTypeId}"`
    )
  }

  if (typeof value.primaryId !== "string") {
    throw new OntologyValidationError(`[Sixb] Property ${path}.primaryId must be a string`)
  }
}
