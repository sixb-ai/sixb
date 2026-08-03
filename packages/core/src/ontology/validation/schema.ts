import { isFileRef } from "../../blob-storage/validation"
import { SixbError } from "../../errors"
import type { ObjectFieldSchema, Schema, ValueType, ValueTypeRefSchema } from ".."
import { isDecimalString } from "../decimal"

/** Recursive schema validator used by both object and link property validation. */
export function validateSchemaValue(
  schema: Schema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  if (typeof schema === "string") {
    switch (schema) {
      case "string":
      case "uuid": {
        if (typeof value !== "string") {
          throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be a string`)
        }
        return
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be a boolean`)
        }
        return
      }
      case "integer": {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new SixbError(
            "ontology.invalid_value",
            `[Sixb] Property ${path} must be an integer`
          )
        }
        return
      }
      case "double": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be numeric`)
        }
        return
      }
      case "decimal": {
        if (!isDecimalString(value)) {
          throw new SixbError(
            "ontology.invalid_value",
            `[Sixb] Property ${path} must be an exact decimal string`
          )
        }
        return
      }
      case "date":
      case "timestamp": {
        if (!(value instanceof Date) && typeof value !== "string") {
          throw new SixbError(
            "ontology.invalid_value",
            `[Sixb] Property ${path} must be a Date or ISO string`
          )
        }
        return
      }
      case "fileRef": {
        if (!isFileRef(value)) {
          throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be a fileRef`)
        }
        return
      }
    }
  }

  if (schema.type === "enum") {
    if (!schema.values.includes(value as never)) {
      throw new SixbError(
        "ontology.invalid_value",
        `[Sixb] Property ${path} must be one of: ${schema.values.join(", ")}`
      )
    }
    return
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be an array`)
    }
    for (let index = 0; index < value.length; index += 1) {
      validateSchemaValue(schema.items, value[index], `${path}[${index}]`, valueTypesById)
    }
    return
  }

  if (schema.type === "map") {
    if (!isRecord(value)) {
      throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be an object map`)
    }
    for (const [key, entry] of Object.entries(value)) {
      validateSchemaValue(schema.valueSchema, entry, `${path}.${key}`, valueTypesById)
    }
    return
  }

  if (schema.type === "object") {
    if (!isRecord(value)) {
      throw new SixbError("ontology.invalid_value", `[Sixb] Property ${path} must be an object`)
    }

    const fields = schema.properties
    const fieldIds = new Set(Object.keys(fields))
    for (const fieldId of Object.keys(value)) {
      if (!fieldIds.has(fieldId)) {
        throw new SixbError("ontology.invalid_value", `[Sixb] Unknown field '${path}.${fieldId}'`)
      }
    }

    for (const [fieldId, field] of Object.entries(fields)) {
      const fieldValue = value[fieldId]
      if (fieldValue === undefined) {
        if (field.required) {
          throw new SixbError(
            "ontology.invalid_value",
            `[Sixb] Missing required field '${path}.${fieldId}'`
          )
        }
        continue
      }

      validateFieldValue(field, fieldValue, `${path}.${fieldId}`, valueTypesById)
    }
    return
  }

  if (schema.type === "valueTypeRef") {
    validateSchemaValue(
      resolveValueTypeSchema(schema, valueTypesById, path),
      value,
      path,
      valueTypesById
    )
  }
}

function validateFieldValue(
  field: ObjectFieldSchema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  if (value === null) {
    if (field.nullable) {
      return
    }
    throw new SixbError("ontology.invalid_value", `[Sixb] Field ${path} cannot be null`)
  }

  validateSchemaValue(field.schema, value, path, valueTypesById)
}

export function resolveValueTypeRef(schema: Schema): string | undefined {
  if (typeof schema === "string") {
    return undefined
  }

  if (schema.type === "valueTypeRef") {
    return schema.valueTypeId
  }

  return undefined
}

export function resolveValueTypeSchema(
  schema: ValueTypeRefSchema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  path: string
): Schema {
  const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
  if (!resolved) {
    throw new SixbError(
      "ontology.invalid_value",
      `[Sixb] Unknown valueTypeRef '${schema.valueTypeId}' at ${path}`
    )
  }
  return resolved
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
