import { isFileRef } from "../../blob-storage/validation"
import { withFailureMessage } from "../../errors/failure-message"
import type { ObjectFieldSchema, Schema, ValueType, ValueTypeRefSchema } from ".."
import { isDecimalString } from "../decimal"
import { OntologyValidationError } from "../errors"

/** Recursive schema validator used by both object and link property validation. */
export function validateSchemaValue(
  schema: Schema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>,
  diagnosticPath = path
): void {
  if (typeof schema === "string") {
    switch (schema) {
      case "string":
      case "uuid": {
        if (typeof value !== "string") {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be a string`),
            `Property ${diagnosticPath} must be a string.`
          )
        }
        return
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be a boolean`),
            `Property ${diagnosticPath} must be a boolean.`
          )
        }
        return
      }
      case "integer": {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be an integer`),
            `Property ${diagnosticPath} must be an integer.`
          )
        }
        return
      }
      case "double": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be numeric`),
            `Property ${diagnosticPath} must be numeric.`
          )
        }
        return
      }
      case "decimal": {
        if (!isDecimalString(value)) {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be an exact decimal string`),
            `Property ${diagnosticPath} must be an exact decimal string.`
          )
        }
        return
      }
      case "date":
      case "timestamp": {
        if (!(value instanceof Date) && typeof value !== "string") {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be a Date or ISO string`),
            `Property ${diagnosticPath} must be a Date or ISO string.`
          )
        }
        return
      }
      case "fileRef": {
        if (!isFileRef(value)) {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Property ${path} must be a fileRef`),
            `Property ${diagnosticPath} must be a fileRef.`
          )
        }
        return
      }
      default:
        // Every primitive validates its values above. Untyped definitions can still carry an
        // unknown string; it keeps falling through without a check.
        schema satisfies never
    }
  }

  if (schema.type === "enum") {
    if (!schema.values.includes(value as never)) {
      throw withFailureMessage(
        new OntologyValidationError(
          `[Sixb] Property ${path} must be one of: ${schema.values.join(", ")}`
        ),
        `Property ${diagnosticPath} must match a declared enum value.`
      )
    }
    return
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw withFailureMessage(
        new OntologyValidationError(`[Sixb] Property ${path} must be an array`),
        `Property ${diagnosticPath} must be an array.`
      )
    }
    for (let index = 0; index < value.length; index += 1) {
      validateSchemaValue(
        schema.items,
        value[index],
        `${path}[${index}]`,
        valueTypesById,
        `${diagnosticPath}[${index}]`
      )
    }
    return
  }

  if (schema.type === "map") {
    if (!isRecord(value)) {
      throw withFailureMessage(
        new OntologyValidationError(`[Sixb] Property ${path} must be an object map`),
        `Property ${diagnosticPath} must be an object map.`
      )
    }
    for (const [key, entry] of Object.entries(value)) {
      validateSchemaValue(
        schema.valueSchema,
        entry,
        `${path}.${key}`,
        valueTypesById,
        `${diagnosticPath}.*`
      )
    }
    return
  }

  if (schema.type === "object") {
    if (!isRecord(value)) {
      throw withFailureMessage(
        new OntologyValidationError(`[Sixb] Property ${path} must be an object`),
        `Property ${diagnosticPath} must be an object.`
      )
    }

    const fields = schema.properties
    const fieldIds = new Set(Object.keys(fields))
    for (const fieldId of Object.keys(value)) {
      if (!fieldIds.has(fieldId)) {
        throw withFailureMessage(
          new OntologyValidationError(`[Sixb] Unknown field '${path}.${fieldId}'`),
          `Object ${diagnosticPath} contains an undeclared field.`
        )
      }
    }

    for (const [fieldId, field] of Object.entries(fields)) {
      const fieldValue = value[fieldId]
      if (fieldValue === undefined) {
        if (field.required) {
          throw withFailureMessage(
            new OntologyValidationError(`[Sixb] Missing required field '${path}.${fieldId}'`),
            `Missing required field '${diagnosticPath}.${fieldId}'.`
          )
        }
        continue
      }

      validateFieldValue(
        field,
        fieldValue,
        `${path}.${fieldId}`,
        valueTypesById,
        `${diagnosticPath}.${fieldId}`
      )
    }
    return
  }

  if (schema.type === "valueTypeRef") {
    validateSchemaValue(
      resolveValueTypeSchema(schema, valueTypesById, path),
      value,
      path,
      valueTypesById,
      diagnosticPath
    )
  }
}

function validateFieldValue(
  field: ObjectFieldSchema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>,
  diagnosticPath = path
): void {
  if (value === null) {
    if (field.nullable) {
      return
    }
    throw withFailureMessage(
      new OntologyValidationError(`[Sixb] Field ${path} cannot be null`),
      `Field ${diagnosticPath} cannot be null.`
    )
  }

  validateSchemaValue(field.schema, value, path, valueTypesById, diagnosticPath)
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
    throw new OntologyValidationError(
      `[Sixb] Unknown valueTypeRef '${schema.valueTypeId}' at ${path}`
    )
  }
  return resolved
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
