type JsonSchema = Record<string, unknown>

interface ActionParamLike {
  readonly id: string
  readonly schema?: unknown
  readonly required?: boolean
  readonly description?: string
}

export function actionParamsToJsonSchema(params: readonly ActionParamLike[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const param of params) {
    properties[param.id] = withDescription(toJsonSchema(param.schema), param.description)
    if (param.required) {
      required.push(param.id)
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

export function toJsonSchema(schema: unknown): JsonSchema {
  if (typeof schema === "string") {
    return primitiveToJsonSchema(schema)
  }

  if (!isRecord(schema)) {
    return {}
  }

  if (schema.type === "objectRef") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["objectTypeId", "primaryId"],
      properties: {
        objectTypeId: { const: schema.objectTypeId },
        primaryId: { type: "string" },
      },
    }
  }

  if (schema.type === "enum") {
    return {
      type: schema.valueType === "integer" ? "integer" : "string",
      enum: Array.isArray(schema.values) ? schema.values : [],
    }
  }

  if (schema.type === "array") {
    return {
      type: "array",
      items: toJsonSchema(schema.items),
    }
  }

  if (schema.type === "map") {
    return {
      type: "object",
      additionalProperties: toJsonSchema(schema.valueSchema),
    }
  }

  if (schema.type === "object") {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    const rawProperties = isRecord(schema.properties) ? schema.properties : {}

    for (const [fieldId, rawField] of Object.entries(rawProperties)) {
      if (!isRecord(rawField)) {
        properties[fieldId] = {}
        continue
      }

      const fieldSchema = toJsonSchema(rawField.schema)
      properties[fieldId] = withDescription(
        rawField.nullable ? nullable(fieldSchema) : fieldSchema,
        typeof rawField.description === "string" ? rawField.description : undefined
      )

      if (rawField.required === true) {
        required.push(fieldId)
      }
    }

    return {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }

  if (schema.type === "valueTypeRef") {
    if ("_resolved" in schema) {
      return toJsonSchema(schema._resolved)
    }

    return {
      description:
        typeof schema.valueTypeId === "string"
          ? `Pario valueTypeRef:${schema.valueTypeId}`
          : "Pario valueTypeRef",
    }
  }

  return {}
}

function primitiveToJsonSchema(schema: string): JsonSchema {
  switch (schema) {
    case "string":
      return { type: "string" }
    case "uuid":
      return { type: "string", format: "uuid" }
    case "date":
      return { type: "string", format: "date" }
    case "timestamp":
      return { type: "string", format: "date-time" }
    case "boolean":
      return { type: "boolean" }
    case "integer":
      return { type: "integer" }
    case "double":
    case "decimal":
      return { type: "number" }
    case "fileRef":
      return {
        type: "object",
        additionalProperties: true,
        description: "Pario fileRef",
      }
    default:
      return {}
  }
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] }
}

function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  if (!description) {
    return schema
  }

  return { ...schema, description }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
