import type {
  ListActionsResponse,
  ObjectAction,
  ActionParam as ObjectActionParam,
} from "@sixb/client"
import { isFileRef } from "@sixb/core/blob-storage"
import { normalizeDecimalValue } from "@sixb/core/ontology"

type ActionCatalogItem = ListActionsResponse[number]
type ActionParam = ActionCatalogItem["params"][number]

export type ActionParamFormValue = string | null
export type ActionParamFormValues = Record<string, ActionParamFormValue | undefined>

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
  | { kind: "decimal" }
  | { kind: "boolean" }
  | { kind: "fileRef" }
  | { kind: "json" }
  | { kind: "enum"; values: readonly unknown[]; valueType: "string" | "integer" }
  | { kind: "objectRef"; objectTypeId: string }

export function buildActionParams(action: ActionCatalogItem, values: ActionParamFormValues) {
  const params: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const param of action.params) {
    const formValue = values[param.id]
    if (formValue === null) {
      if (param.nullable) {
        params[param.id] = null
      } else {
        errors[param.id] = "This parameter cannot be null."
      }
      continue
    }

    const rawValue = formValue?.trim() ?? ""
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

export function buildObjectActionParams(action: ObjectAction, values: ActionParamFormValues) {
  const params: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const [paramId, param] of Object.entries(action.params ?? {})) {
    const formValue = values[paramId]
    if (formValue === null) {
      if (param.nullable) {
        params[paramId] = null
      } else {
        errors[paramId] = "This parameter cannot be null."
      }
      continue
    }

    const rawValue = formValue?.trim() ?? ""
    if (!rawValue) {
      if (param.required) errors[paramId] = "Required."
      continue
    }

    try {
      params[paramId] = parseObjectActionParamValue(param, rawValue)
    } catch (error) {
      errors[paramId] = error instanceof Error ? error.message : "Invalid value."
    }
  }

  return { params, errors }
}

export function actionNeedsParamDialog(action: ObjectAction): boolean {
  return Object.values(action.params ?? {}).some(
    (param) => param.required || param.nullable || param.type === "fileRef"
  )
}

export function describeActionParamInput(schema: unknown): ActionParamInputDescriptor {
  const resolved = resolveSchemaForForm(schema)

  if (resolved === "integer") {
    return { kind: "number", integer: true }
  }
  if (resolved === "double") {
    return { kind: "number" }
  }
  if (resolved === "decimal") return { kind: "decimal" }
  if (resolved === "boolean") {
    return { kind: "boolean" }
  }
  if (resolved === "fileRef") {
    return { kind: "fileRef" }
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

function parseObjectActionParamValue(param: ObjectActionParam, rawValue: string): unknown {
  if (param.type === "number") {
    const value = Number(rawValue)
    if (!Number.isFinite(value)) {
      throw new Error("Expected a number.")
    }
    return value
  }
  if (param.type === "boolean") {
    return rawValue === "true"
  }
  if (param.type === "fileRef") {
    const fileRef = JSON.parse(rawValue) as unknown
    if (!isFileRef(fileRef)) {
      throw new Error("Expected an uploaded file.")
    }
    return fileRef
  }
  return rawValue
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
    case "decimal":
      try {
        return normalizeDecimalValue(rawValue)
      } catch {
        throw new Error("Expected an exact decimal.")
      }
    case "boolean":
      return rawValue === "true"
    case "fileRef": {
      const parsed = JSON.parse(rawValue) as unknown
      if (!isFileRef(parsed)) {
        throw new Error("Expected an uploaded file.")
      }
      return parsed
    }
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
