import { SixbError } from "../errors"
import type { InferSchema } from "./inference"
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
  TValueTypes extends readonly ValueType[] = [],
> =
  TSchema extends ObjectRefSchema<infer TObjectTypeId>
    ? ObjectRef<TObjectTypeId>
    : TSchema extends Schema
      ? InferSchema<TSchema, TValueTypes>
      : never

export function ref<const TObjectType extends ObjectType>(
  objectType: TObjectType
): ObjectRefSchema<TObjectType["id"]> {
  return {
    type: "objectRef",
    objectTypeId: objectType.id,
  }
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
    throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be an objectRef`)
  }

  const allowedFields = new Set(["objectTypeId", "primaryId"])
  for (const fieldId of Object.keys(value)) {
    if (!allowedFields.has(fieldId)) {
      throw new SixbError("ontology.invalid_value", `[Sixb] Unknown field '${path}.${fieldId}'`)
    }
  }

  if (value.objectTypeId !== schema.objectTypeId) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] Property ${path}.objectTypeId must be "${schema.objectTypeId}"`
    )
  }

  if (typeof value.primaryId !== "string") {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] Property ${path}.primaryId must be a string`
    )
  }
}
