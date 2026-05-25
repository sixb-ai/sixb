import { type ValueType, validateSchemaOrRefValue } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { ActionDefinitionError } from "./errors"
import type {
  ActionDefinition,
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
