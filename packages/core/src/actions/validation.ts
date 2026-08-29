import type { JsonValue } from "../json"
import { type SchemaOrRef, type ValueType, validateSchemaOrRefValue } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { Schema } from "../ontology/types"
import { coerceSchemaValueToTyped, normalizeSchemaValue } from "../ontology/validation"
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
    listForType(objectType: ObjectTypeWithPropertyTokens): readonly ObjectActionDefinition[]
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

    if (value === null) {
      if (!paramDef.nullable) {
        throw new OntologyValidationError(
          `[Sixb] Action param ${pathPrefix}.${paramId} cannot be null`
        )
      }
      normalized[paramId] = null
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

/**
 * Re-hydrate stored action params for the handler-facing surface. Params are
 * normalized to JSON (e.g. `date`/`timestamp` -> ISO string) for storage; action
 * handler types promise `Date` for those, so this converts them back before the
 * handler runs. `objectRef` params pass through unchanged.
 */
export function coerceActionParamsToTyped(
  paramsConfig: ActionParamsConfig,
  params: Record<string, unknown>,
  valueTypesById: ReadonlyMap<string, ValueType>
): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...params }

  for (const [paramId, paramDef] of Object.entries(paramsConfig)) {
    const value = params[paramId]
    if (value === undefined) continue

    const schema = paramDef.schema
    if (typeof schema === "object" && schema !== null && schema.type === "objectRef") {
      continue
    }

    coerced[paramId] = coerceSchemaValueToTyped(schema as Schema, value, valueTypesById)
  }

  return coerced
}

export function validateActionSubject(action: ActionDefinition, subject: ActionSubject): void {
  if (isGlobalActionDefinition(action) && subject.kind !== "none") {
    throw new OntologyValidationError(`Action '${action.id}' does not accept an object subject.`)
  }
}

/** Whether an object subject names the exact type an Action is defined on, excluding subtypes. */
export function isExactObjectActionTarget(
  action: ActionDefinition,
  objectTypeId: string
): action is ObjectActionDefinition {
  return isObjectActionDefinition(action) && action.binding.objectType.id === objectTypeId
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
    .listForType(objectType)
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
