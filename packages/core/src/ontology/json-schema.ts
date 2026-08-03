import { SixbError } from "../errors"
import { isObjectRefSchema, type SchemaOrRef } from "./refs"
import type { Schema, ValueType } from "./types"

export type SchemaJsonSchema = Readonly<Record<string, unknown>>

/** Convert a record of Sixb schemas into the strict JSON object schema used by model outputs. */
export function schemaRecordToJsonSchema(input: {
  readonly shape: Readonly<Record<string, SchemaOrRef>>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): SchemaJsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(input.shape).map(([field, schema]) => [
        field,
        schemaOrRefJsonSchema(schema, input.valueTypesById, new Set()),
      ])
    ),
    required: Object.keys(input.shape),
    additionalProperties: false,
  }
}

function schemaOrRefJsonSchema(
  schema: SchemaOrRef,
  valueTypesById: ReadonlyMap<string, ValueType>,
  resolving: ReadonlySet<string>
): SchemaJsonSchema {
  if (isObjectRefSchema(schema)) {
    return {
      type: "object",
      properties: {
        objectTypeId: { type: "string", const: schema.objectTypeId },
        primaryId: { type: "string" },
      },
      required: ["objectTypeId", "primaryId"],
      additionalProperties: false,
    }
  }
  return schemaJsonSchema(schema, valueTypesById, resolving)
}

function schemaJsonSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  resolving: ReadonlySet<string>
): SchemaJsonSchema {
  if (typeof schema === "string") {
    switch (schema) {
      case "string":
        return { type: "string" }
      case "integer":
        return { type: "integer" }
      case "double":
      case "decimal":
        return { type: "number" }
      case "boolean":
        return { type: "boolean" }
      case "date":
        return { type: "string", format: "date" }
      case "timestamp":
        return { type: "string", format: "date-time" }
      case "uuid":
        return { type: "string", format: "uuid" }
      case "fileRef":
        return {
          type: "object",
          properties: {
            blobId: { type: "string" },
            digest: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" },
            sizeBytes: { type: "integer", minimum: 0 },
            fileName: { type: "string" },
            mediaType: { type: "string" },
            logicalPath: { type: "string" },
          },
          required: ["blobId", "digest", "sizeBytes"],
          additionalProperties: false,
        }
    }
  }

  if (schema.type === "enum") return { enum: schema.values }
  if (schema.type === "array") {
    return { type: "array", items: schemaJsonSchema(schema.items, valueTypesById, resolving) }
  }
  if (schema.type === "map") {
    return {
      type: "object",
      additionalProperties: schemaJsonSchema(schema.valueSchema, valueTypesById, resolving),
    }
  }
  if (schema.type === "object") {
    const required: string[] = []
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([fieldId, field]) => {
        if (field.required) required.push(fieldId)
        const fieldSchema = schemaJsonSchema(field.schema, valueTypesById, resolving)
        return [fieldId, field.nullable ? { anyOf: [fieldSchema, { type: "null" }] } : fieldSchema]
      })
    )
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    }
  }

  const valueTypeId = schema.valueTypeId
  if (resolving.has(valueTypeId)) {
    throw new SixbError(
      "ontology.invalid_value",
      `Structured output contains a recursive value type '${valueTypeId}'.`
    )
  }
  const resolved = schema._resolved ?? valueTypesById.get(valueTypeId)?.schema
  if (!resolved) {
    throw new SixbError(
      "ontology.invalid_value",
      `Structured output references unknown value type '${valueTypeId}'.`
    )
  }
  return schemaJsonSchema(resolved, valueTypesById, new Set([...resolving, valueTypeId]))
}
