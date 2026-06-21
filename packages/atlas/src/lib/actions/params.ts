import type { ListActionsResponse } from "@sixb/client"

type ActionCatalogItem = ListActionsResponse[number]
type ActionParam = ActionCatalogItem["params"][number]

export type ActionRequestPayload = {
  path: { actionId: string }
  body: {
    subject?: { kind: "none" } | { kind: "object"; objectTypeId: string; primaryId: string }
    params?: Record<string, unknown>
    runId?: string
  }
}

export type ActionParamInputDescriptor =
  | { kind: "text" }
  | { kind: "number"; integer?: boolean }
  | { kind: "boolean" }
  | { kind: "json" }
  | { kind: "enum"; values: readonly unknown[]; valueType: "string" | "integer" }
  | { kind: "objectRef"; objectTypeId: string }

export function buildActionParams(action: ActionCatalogItem, values: Record<string, string>) {
  const params: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const param of action.params) {
    const rawValue = values[param.id]?.trim() ?? ""
    if (!rawValue) {
      if (param.required) {
        errors[param.id] = "Required."
      }
      continue
    }

    try {
      params[param.id] = parseActionParamValue(param, rawValue)
    } catch (error) {
      errors[param.id] = error instanceof Error ? error.message : "Invalid value."
    }
  }

  return { params, errors }
}

export function describeActionParamInput(schema: unknown): ActionParamInputDescriptor {
  const resolved = resolveSchemaForForm(schema)

  if (resolved === "integer") {
    return { kind: "number", integer: true }
  }
  if (resolved === "double" || resolved === "decimal") {
    return { kind: "number" }
  }
  if (resolved === "boolean") {
    return { kind: "boolean" }
  }
  if (isRecord(resolved)) {
    if (resolved.type === "objectRef" && typeof resolved.objectTypeId === "string") {
      return { kind: "objectRef", objectTypeId: resolved.objectTypeId }
    }
    if (resolved.type === "enum" && Array.isArray(resolved.values)) {
      return {
        kind: "enum",
        values: resolved.values,
        valueType: resolved.valueType === "integer" ? "integer" : "string",
      }
    }
    if (resolved.type === "valueTypeRef") {
      return { kind: "json" }
    }
    return { kind: "json" }
  }
  return { kind: "text" }
}

function parseActionParamValue(param: ActionParam, rawValue: string): unknown {
  const input = describeActionParamInput(param.schema)
  switch (input.kind) {
    case "number": {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) {
        throw new Error("Expected a number.")
      }
      if (input.integer && !Number.isInteger(value)) {
        throw new Error("Expected an integer.")
      }
      return value
    }
    case "boolean":
      return rawValue === "true"
    case "json":
      return JSON.parse(rawValue)
    case "enum":
      return input.valueType === "integer"
        ? parseIntegerEnumValue(rawValue, input.values)
        : rawValue
    case "objectRef":
      return { objectTypeId: input.objectTypeId, primaryId: rawValue }
    case "text":
      return rawValue
  }
}

function parseIntegerEnumValue(rawValue: string, values: readonly unknown[]): number {
  const value = Number(rawValue)
  if (!Number.isInteger(value)) {
    throw new Error("Expected an integer enum value.")
  }
  if (!values.includes(value)) {
    throw new Error("Unknown enum value.")
  }
  return value
}

function resolveSchemaForForm(schema: unknown): unknown {
  if (!isRecord(schema) || schema.type !== "valueTypeRef") {
    return schema
  }
  return schema._resolved ?? schema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
