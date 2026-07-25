import type { ObjectLink, Property, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import {
  assertKnownProperties,
  normalizeObjectProperties,
  validateObjectProperties,
  validatePropertyValue,
} from "../ontology/validation"
import { EditBatchError } from "./errors"
import type { EditObjectProperties } from "./types"

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
  return normalizeObjectProperties(objectType.properties, properties, valueTypesById, path)
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

  return normalizeObjectProperties(
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

/** Validates `unset`/`reset` targets: known, non-primary, and not telemetry-backed. */
export function normalizeEditablePropertyIds(params: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly propertyIds: readonly unknown[]
  readonly operation: "unset" | "reset"
}): readonly string[] {
  const { objectType, propertyIds, operation } = params
  const primaryProperty = getPrimaryProperty(objectType)
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const propertyId of propertyIds) {
    if (typeof propertyId !== "string" || !propertyId.trim()) {
      throw new EditBatchError(
        `[Sixb] EditBatch ${objectType.id}.${operation} property id must be a non-empty string.`
      )
    }
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    if (!property) {
      throw new EditBatchError(
        `[Sixb] EditBatch ${operation} references unknown property '${objectType.id}.${propertyId}'.`
      )
    }
    if (property.id === primaryProperty.id) {
      throw new EditBatchError(
        `[Sixb] EditBatch cannot ${operation} primary property '${objectType.id}.${propertyId}'.`
      )
    }
    if (property.mode === "telemetry") {
      throw new EditBatchError(
        `[Sixb] EditBatch cannot ${operation} telemetry property '${objectType.id}.${propertyId}'.`
      )
    }
    if (seen.has(propertyId)) continue
    seen.add(propertyId)
    normalized.push(propertyId)
  }

  if (normalized.length === 0) {
    throw new EditBatchError(
      `[Sixb] EditBatch ${objectType.id}.${operation} requires at least one property id.`
    )
  }
  return normalized
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
