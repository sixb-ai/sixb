import { isPlainRecord, type JsonValue } from "../../json"
import type { SchemaOrRef, ValueType } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import { validateSchemaOrRefValue } from "../../ontology/refs"
import type { Schema } from "../../ontology/types"
import { coerceSchemaValueToTyped, normalizeSchemaValue } from "../../ontology/validation"
import type { ParamsConfig } from "./types"

export interface ParamsOwner {
  /** Lowercase singular name used in validation errors, for example `action` or `agent`. */
  readonly kind: string
  readonly id: string
  /** Stable value path passed to ontology validation. Defaults to `id`. */
  readonly path?: string
}

/** Validate declarative params and normalize them to their durable JSON representation. */
export function normalizeParams(
  valueTypesById: ReadonlyMap<string, ValueType>,
  paramsConfig: ParamsConfig,
  params: Record<string, unknown>,
  owner: ParamsOwner
): Record<string, JsonValue> {
  if (!isPlainRecord(params)) {
    throw new OntologyValidationError(`[Sixb] ${capitalize(owner.kind)} params must be an object.`)
  }
  const knownParamIds = new Set(Object.keys(paramsConfig))
  const normalized: [string, JsonValue][] = []

  for (const paramId of Object.keys(params)) {
    if (!knownParamIds.has(paramId)) {
      throw new OntologyValidationError(
        `Unknown param '${paramId}' for ${owner.kind} '${owner.id}'`
      )
    }
  }

  for (const [paramId, paramDef] of Object.entries(paramsConfig)) {
    const value = Object.hasOwn(params, paramId) ? params[paramId] : undefined

    if (value === undefined) {
      if (paramDef.required) {
        throw new OntologyValidationError(
          `Missing required param '${paramId}' for ${owner.kind} '${owner.id}'`
        )
      }
      continue
    }

    const path = `${owner.path ?? owner.id}.${paramId}`
    if (value === null) {
      if (!paramDef.nullable) {
        throw new OntologyValidationError(
          `[Sixb] ${capitalize(owner.kind)} param ${path} cannot be null`
        )
      }
      normalized.push([paramId, null])
      continue
    }

    validateSchemaOrRefValue(paramDef.schema, value, path, valueTypesById)
    normalized.push([
      paramId,
      normalizeSchemaOrRefValue(paramDef.schema, value, path, valueTypesById),
    ])
  }

  return Object.fromEntries(normalized)
}

/** Re-hydrate normalized storage values for typed runtime consumers. */
export function coerceParamsToTyped(
  paramsConfig: ParamsConfig,
  params: Record<string, unknown>,
  valueTypesById: ReadonlyMap<string, ValueType>
): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...params }

  for (const [paramId, paramDef] of Object.entries(paramsConfig)) {
    if (!Object.hasOwn(params, paramId)) continue
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

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`
}
