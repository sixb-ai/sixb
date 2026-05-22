import type { JsonValue } from "../json"
import { isObjectRefSchema, type Schema, type SchemaOrRef, type ValueType } from "../ontology"
import { WorkflowValidationError } from "./errors"
import type { StepDefinition, WorkflowDefinition, WorkflowIOSnapshot } from "./types"
import {
  validateWorkflowInput,
  validateWorkflowStepInput,
  validateWorkflowStepOutput,
} from "./validation"

export function snapshotWorkflowInput(params: {
  readonly workflow: WorkflowDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): WorkflowIOSnapshot {
  const value = validateWorkflowInput(params)
  return snapshotWorkflowContractRecord({
    shape: params.workflow.input as Readonly<Record<string, SchemaOrRef>>,
    value,
    path: `Workflow "${params.workflow.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function snapshotWorkflowStepInput(params: {
  readonly workflowId: string
  readonly step: StepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): WorkflowIOSnapshot {
  const value = validateWorkflowStepInput(params)
  return snapshotWorkflowContractRecord({
    shape: params.step.input as Readonly<Record<string, SchemaOrRef>>,
    value,
    path: `Workflow "${params.workflowId}" step "${params.step.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function snapshotWorkflowStepOutput(params: {
  readonly workflowId: string
  readonly step: StepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): WorkflowIOSnapshot {
  const value = validateWorkflowStepOutput(params)
  return snapshotWorkflowContractRecord({
    shape: params.step.output as Readonly<Record<string, SchemaOrRef>>,
    value,
    path: `Workflow "${params.workflowId}" step "${params.step.id}" output`,
    valueTypesById: params.valueTypesById,
  })
}

export function snapshotWorkflowActionInput(params: {
  readonly target: { readonly objectTypeId: string; readonly primaryId: string }
  readonly params: Readonly<Record<string, unknown>>
}): WorkflowIOSnapshot {
  return {
    target: {
      objectTypeId: params.target.objectTypeId,
      primaryId: params.target.primaryId,
    },
    params: snapshotJsonValue(params.params, "Workflow action params"),
  }
}

function snapshotWorkflowContractRecord(params: {
  readonly shape: Readonly<Record<string, SchemaOrRef>>
  readonly value: Readonly<Record<string, unknown>>
  readonly path: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): WorkflowIOSnapshot {
  const snapshot: Record<string, JsonValue> = {}

  for (const [fieldId, schema] of Object.entries(params.shape)) {
    snapshot[fieldId] = snapshotSchemaOrRefValue({
      schema,
      value: params.value[fieldId],
      path: `${params.path}.${fieldId}`,
      valueTypesById: params.valueTypesById,
    })
  }

  return snapshot
}

function snapshotSchemaOrRefValue(params: {
  readonly schema: SchemaOrRef
  readonly value: unknown
  readonly path: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): JsonValue {
  if (isObjectRefSchema(params.schema)) {
    if (!isRecord(params.value)) {
      throw cannotSerialize(params.path)
    }

    return {
      objectTypeId: String(params.value.objectTypeId),
      primaryId: String(params.value.primaryId),
    }
  }

  return snapshotSchemaValue({
    schema: params.schema,
    value: params.value,
    path: params.path,
    valueTypesById: params.valueTypesById,
  })
}

function snapshotSchemaValue(params: {
  readonly schema: Schema
  readonly value: unknown
  readonly path: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): JsonValue {
  const { schema, value, path, valueTypesById } = params

  if (typeof schema === "string") {
    if (schema === "date" || schema === "timestamp") {
      if (value instanceof Date) {
        return snapshotDate(value, path)
      }
      return snapshotJsonValue(value, path)
    }

    return snapshotJsonValue(value, path)
  }

  if (schema.type === "enum") {
    return snapshotJsonValue(value, path)
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw cannotSerialize(path)
    }

    return value.map((item, index) =>
      snapshotSchemaValue({
        schema: schema.items,
        value: item,
        path: `${path}[${index}]`,
        valueTypesById,
      })
    )
  }

  if (schema.type === "map") {
    if (!isRecord(value)) {
      throw cannotSerialize(path)
    }

    const snapshot: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      snapshot[key] = snapshotSchemaValue({
        schema: schema.valueSchema,
        value: entry,
        path: `${path}.${key}`,
        valueTypesById,
      })
    }
    return snapshot
  }

  if (schema.type === "object") {
    if (!isRecord(value)) {
      throw cannotSerialize(path)
    }

    const snapshot: Record<string, JsonValue> = {}
    for (const [fieldId, field] of Object.entries(schema.properties)) {
      const fieldValue = value[fieldId]
      if (fieldValue === undefined) {
        continue
      }

      if (fieldValue === null) {
        snapshot[fieldId] = null
        continue
      }

      snapshot[fieldId] = snapshotSchemaValue({
        schema: field.schema,
        value: fieldValue,
        path: `${path}.${fieldId}`,
        valueTypesById,
      })
    }
    return snapshot
  }

  if (schema.type === "valueTypeRef") {
    const valueType = valueTypesById.get(schema.valueTypeId)
    if (!valueType) {
      throw new WorkflowValidationError(
        `[Pario] Unknown valueTypeRef '${schema.valueTypeId}' at ${path}`
      )
    }

    return snapshotSchemaValue({
      schema: valueType.schema,
      value,
      path,
      valueTypesById,
    })
  }

  return snapshotJsonValue(value, path)
}

function snapshotJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw cannotSerialize(path)
    }
    return value
  }

  if (value instanceof Date) {
    return snapshotDate(value, path)
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => snapshotJsonValue(item, `${path}[${index}]`))
  }

  if (isPlainRecord(value)) {
    const snapshot: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      snapshot[key] = snapshotJsonValue(entry, `${path}.${key}`)
    }
    return snapshot
  }

  throw cannotSerialize(path)
}

function snapshotDate(value: Date, path: string): string {
  if (Number.isNaN(value.getTime())) {
    throw cannotSerialize(path)
  }

  return value.toISOString()
}

function cannotSerialize(path: string): WorkflowValidationError {
  return new WorkflowValidationError(`[Pario] ${path} cannot be serialized as workflow IO`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
