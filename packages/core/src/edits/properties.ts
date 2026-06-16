import { assertJsonValue, cloneJsonValue, type JsonValue } from "../json"
import type { ObjectLink, Property, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens, PropertyToken } from "../ontology/tokens"
import {
  assertKnownProperties,
  normalizeSchemaValue,
  validateObjectProperties,
  validatePropertyValue,
} from "../ontology/validation"
import { EditBatchError } from "./errors"
import type { EditObjectProperties, EditObjectRef } from "./types"

export function normalizeObjectEditProperties(params: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly properties: Record<string, unknown>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly path: string
}): EditObjectProperties {
  const { objectType, properties, valueTypesById, path } = params
  assertKnownProperties(objectType, properties)
  assertNoTelemetryProperties(objectType.properties, properties, path)
  validateObjectProperties(objectType, properties, valueTypesById)
  return normalizeProperties(objectType.properties, properties, valueTypesById, path)
}

export function normalizePropertyTokenEdit(params: {
  readonly ref: EditObjectRef
  readonly property: PropertyToken<string, string, Property>
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): EditObjectProperties {
  const { ref, property, value, valueTypesById } = params
  assertNoTelemetryProperties([property.property], { [property.id]: value }, ref.objectTypeId)
  validatePropertyValue(
    property.property,
    value,
    `${ref.objectTypeId}.${property.id}`,
    valueTypesById
  )
  return {
    [property.id]: normalizePropertyValue(
      property.property,
      value,
      `${ref.objectTypeId}.${property.id}`,
      valueTypesById
    ),
  }
}

export function normalizeLinkEditProperties(params: {
  readonly sourceObjectTypeId: string
  readonly linkId: string
  readonly linkDefinition: ObjectLink
  readonly properties: Readonly<Record<string, unknown>>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): EditObjectProperties {
  const { sourceObjectTypeId, linkId, linkDefinition, properties, valueTypesById } = params
  const linkProperties = linkDefinition.properties ?? []

  if (linkProperties.length === 0 && Object.keys(properties).length > 0) {
    throw new OntologyValidationError(
      `[Sixb] Link ${sourceObjectTypeId}.${linkId} does not define link properties`
    )
  }

  const knownPropertyIds = new Set(linkProperties.map((property) => property.id))
  for (const propertyId of Object.keys(properties)) {
    if (!knownPropertyIds.has(propertyId)) {
      throw new OntologyValidationError(
        `[Sixb] Unknown link property '${propertyId}' for link '${sourceObjectTypeId}.${linkId}'`
      )
    }
  }

  assertNoTelemetryProperties(linkProperties, properties, `${sourceObjectTypeId}.${linkId}`)

  for (const [propertyId, value] of Object.entries(properties)) {
    const property = linkProperties.find((candidate) => candidate.id === propertyId)
    if (!property) continue
    validatePropertyValue(
      property,
      value,
      `${sourceObjectTypeId}.${linkId}.${propertyId}`,
      valueTypesById
    )
  }

  return normalizeProperties(
    linkProperties,
    properties,
    valueTypesById,
    `${sourceObjectTypeId}.${linkId}`
  )
}

export function getPrimaryProperty(objectType: ObjectTypeWithPropertyTokens): Property {
  const primaryProperty = objectType.properties.find((property) => property.primary)
  if (!primaryProperty) {
    throw new OntologyValidationError(
      `[Sixb] Object type '${objectType.id}' has no primary property`
    )
  }
  return primaryProperty
}

export function assertPrimaryPropertyNotUpdated(
  objectType: ObjectTypeWithPropertyTokens,
  properties: EditObjectProperties
): void {
  const primaryProperty = getPrimaryProperty(objectType)
  if (Object.hasOwn(properties, primaryProperty.id)) {
    throw new EditBatchError(
      `[Sixb] EditBatch cannot update primary property '${objectType.id}.${primaryProperty.id}'.`
    )
  }
}

export function cloneJsonProperties(
  properties: Readonly<Record<string, unknown>>,
  path: string
): EditObjectProperties {
  assertJsonValue(properties, path)
  return cloneJsonValue(properties as JsonValue) as EditObjectProperties
}

function normalizeProperties(
  definitions: readonly Property[],
  properties: Readonly<Record<string, unknown>>,
  valueTypesById: ReadonlyMap<string, ValueType>,
  path: string
): EditObjectProperties {
  const normalized: Record<string, JsonValue> = {}
  for (const [propertyId, value] of Object.entries(properties)) {
    const property = definitions.find((candidate) => candidate.id === propertyId)
    if (!property) continue
    normalized[propertyId] = normalizePropertyValue(
      property,
      value,
      `${path}.${propertyId}`,
      valueTypesById
    )
  }
  return normalized
}

function normalizePropertyValue(
  property: Property,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (value === null) {
    return null
  }
  return normalizeSchemaValue(property.schema, value, path, valueTypesById)
}

function assertNoTelemetryProperties(
  definitions: readonly Property[],
  properties: Readonly<Record<string, unknown>>,
  path: string
): void {
  for (const propertyId of Object.keys(properties)) {
    const property = definitions.find((candidate) => candidate.id === propertyId)
    if (property?.mode === "telemetry") {
      throw new EditBatchError(
        `[Sixb] EditBatch cannot edit telemetry property '${path}.${propertyId}' in the MVP.`
      )
    }
  }
}
