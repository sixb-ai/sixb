import { assertJsonValue, cloneJsonValue, type JsonValue } from "../json"
import { type SchemaOrRef, type ValueType, validateSchemaOrRefValue } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ObjectFieldSchema, Schema } from "../ontology/types"
import type { ActionRunParams } from "../storage/action-runs"
import { ActionDefinitionError } from "./errors"
import type {
  ActionDefinition,
  ActionParamsConfig,
  ActionSubject,
  GlobalActionDefinition,
  ObjectActionDefinition,
} from "./types"

interface ActionValidationRuntime {
  readonly ontology: {
    getValueTypesById(): ReadonlyMap<string, ValueType>
    resolveObjectType(objectTypeId: string): ObjectTypeWithPropertyTokens
  }
  readonly actionRegistry: {
    getActionsForType(objectType: ObjectTypeWithPropertyTokens): readonly ObjectActionDefinition[]
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ActionDefinitionError(`Action ${field} must not be empty.`)
  }
}

export function isActionDefinition(value: unknown): value is ActionDefinition {
  const binding = (value as { binding?: { kind?: unknown } } | null)?.binding
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "action" &&
    (binding?.kind === "global" || binding?.kind === "object")
  )
}

export function isGlobalActionDefinition(value: ActionDefinition): value is GlobalActionDefinition {
  return value.binding.kind === "global"
}

export function isObjectActionDefinition(value: ActionDefinition): value is ObjectActionDefinition {
  return value.binding.kind === "object"
}

export function validateActionParams(
  runtime: Pick<ActionValidationRuntime, "ontology">,
  action: ActionDefinition,
  params: Record<string, unknown>,
  pathPrefix: string
): void {
  const knownParamIds = new Set(Object.keys(action.params))

  for (const paramId of Object.keys(params)) {
    if (!knownParamIds.has(paramId)) {
      throw new OntologyValidationError(`Unknown param '${paramId}' for action '${pathPrefix}'`)
    }
  }

  for (const [paramId, paramDef] of Object.entries(action.params)) {
    if (paramDef.required && params[paramId] === undefined) {
      throw new OntologyValidationError(
        `Missing required param '${paramId}' for action '${pathPrefix}'`
      )
    }

    if (params[paramId] !== undefined) {
      validateSchemaOrRefValue(
        paramDef.schema,
        params[paramId],
        `${pathPrefix}.${paramId}`,
        runtime.ontology.getValueTypesById()
      )
    }
  }
}

export function normalizeActionParams(
  runtime: Pick<ActionValidationRuntime, "ontology">,
  paramsConfig: ActionParamsConfig,
  params: Record<string, unknown>,
  pathPrefix: string
): ActionRunParams {
  const knownParamIds = new Set(Object.keys(paramsConfig))
  const normalized: Record<string, JsonValue> = {}

  for (const paramId of Object.keys(params)) {
    if (!knownParamIds.has(paramId)) {
      throw new OntologyValidationError(`Unknown param '${paramId}' for action '${pathPrefix}'`)
    }
  }

  for (const [paramId, paramDef] of Object.entries(paramsConfig)) {
    const value = params[paramId]

    if (value === undefined) {
      if (paramDef.required) {
        throw new OntologyValidationError(
          `Missing required param '${paramId}' for action '${pathPrefix}'`
        )
      }
      continue
    }

    validateSchemaOrRefValue(
      paramDef.schema,
      value,
      `${pathPrefix}.${paramId}`,
      runtime.ontology.getValueTypesById()
    )

    normalized[paramId] = normalizeSchemaOrRefValue(
      paramDef.schema,
      value,
      `${pathPrefix}.${paramId}`,
      runtime.ontology.getValueTypesById()
    )
  }

  return normalized
}

export function validateActionSubject(action: ActionDefinition, subject: ActionSubject): void {
  if (isGlobalActionDefinition(action) && subject.kind !== "none") {
    throw new OntologyValidationError(`Action '${action.id}' does not accept an object subject.`)
  }
}

export function resolveObjectActionSubject(params: {
  readonly runtime: ActionValidationRuntime
  readonly action: ObjectActionDefinition
  readonly subject: ActionSubject
}): ObjectTypeWithPropertyTokens {
  const { runtime, action, subject } = params

  if (subject.kind !== "object") {
    throw new OntologyValidationError(`Action '${action.id}' requires an object subject.`)
  }

  const objectType = runtime.ontology.resolveObjectType(subject.objectTypeId)
  if (!actionAppliesToObjectType(runtime, action, objectType)) {
    throw new OntologyValidationError(
      `Action '${action.id}' is not valid for object type '${objectType.id}'.`
    )
  }

  return objectType
}

function actionAppliesToObjectType(
  runtime: Pick<ActionValidationRuntime, "actionRegistry">,
  action: ObjectActionDefinition,
  objectType: ObjectTypeWithPropertyTokens
): boolean {
  return runtime.actionRegistry
    .getActionsForType(objectType)
    .some((candidate) => candidate.id === action.id)
}

function normalizeSchemaOrRefValue(
  schema: SchemaOrRef,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (typeof schema === "object" && schema !== null && schema.type === "objectRef") {
    const refValue = value as { objectTypeId: string; primaryId: string }
    return {
      objectTypeId: refValue.objectTypeId,
      primaryId: refValue.primaryId,
    }
  }

  return normalizeSchemaValue(schema as Schema, value, path, valueTypesById)
}

function normalizeSchemaValue(
  schema: Schema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (typeof schema === "string") {
    switch (schema) {
      case "date":
        return normalizeDateValue(value, path)
      case "timestamp":
        return normalizeTimestampValue(value, path)
      default:
        assertJsonValue(value, path)
        return cloneJsonValue(value)
    }
  }

  if (schema.type === "valueTypeRef") {
    const valueType = valueTypesById.get(schema.valueTypeId)
    if (!valueType) {
      throw new OntologyValidationError(
        `[Sixb] Unknown valueTypeRef '${schema.valueTypeId}' at ${path}`
      )
    }
    return normalizeSchemaValue(valueType.schema, value, path, valueTypesById)
  }

  if (schema.type === "enum") {
    assertJsonValue(value, path)
    return cloneJsonValue(value)
  }

  if (schema.type === "array") {
    return (value as readonly unknown[]).map((entry, index) =>
      normalizeSchemaValue(schema.items, entry, `${path}[${index}]`, valueTypesById)
    )
  }

  if (schema.type === "map") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      normalizeSchemaValue(schema.valueSchema, entry, `${path}.${key}`, valueTypesById),
    ])
    return Object.fromEntries(entries)
  }

  const fields = schema.properties
  const output: Record<string, JsonValue> = {}
  for (const [fieldId, field] of Object.entries(fields)) {
    const fieldValue = (value as Record<string, unknown>)[fieldId]
    if (fieldValue === undefined) {
      continue
    }
    output[fieldId] = normalizeObjectFieldValue(
      field,
      fieldValue,
      `${path}.${fieldId}`,
      valueTypesById
    )
  }
  return output
}

function normalizeObjectFieldValue(
  field: ObjectFieldSchema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (value === null) {
    return null
  }

  return normalizeSchemaValue(field.schema, value, path, valueTypesById)
}

function normalizeDateValue(value: unknown, path: string): string {
  const date = normalizeDateLike(value, path)
  return date.toISOString().slice(0, 10)
}

function normalizeTimestampValue(value: unknown, path: string): string {
  return normalizeDateLike(value, path).toISOString()
}

function normalizeDateLike(value: unknown, path: string): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be a valid date`)
  }
  return date
}
