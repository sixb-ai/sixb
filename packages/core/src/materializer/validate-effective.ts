import type { JsonValue } from "../json"
import type { OntologyRegistry } from "../ontology"
import {
  assertKnownProperties,
  validateLinkProperties,
  validateObjectProperties,
  validatePropertyValue,
  validateTelemetryUnit,
} from "../ontology/validation"
import { MaterializationValidationError } from "./errors"
import type { OntologyLinkRef, OntologyObjectRef, TelemetryPointWrite } from "./types"

export function validateObjectRef(ontology: OntologyRegistry, ref: OntologyObjectRef): void {
  materializationValidation(() => {
    ontology.resolveObjectType(ref.objectTypeId)
  })
}

export function validateLinkRef(ontology: OntologyRegistry, ref: OntologyLinkRef): void {
  materializationValidation(() => {
    const sourceType = ontology.resolveObjectType(ref.source.objectTypeId)
    ontology.resolveObjectType(ref.target.objectTypeId)
    const link = sourceType.links.find((candidate) => candidate.id === ref.linkId)
    if (!link) throw new Error(`[Sixb] Unknown link '${ref.source.objectTypeId}.${ref.linkId}'.`)
    if (!ontology.isValidLinkTarget(link.targetObjectTypeId, ref.target.objectTypeId)) {
      throw new Error(
        `[Sixb] Link '${ref.source.objectTypeId}.${ref.linkId}' cannot target '${ref.target.objectTypeId}'.`
      )
    }
  })
}

export function validateObjectAuthorityProperties(
  ontology: OntologyRegistry,
  ref: OntologyObjectRef,
  properties: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> {
  return materializationValidation(() => {
    const objectType = ontology.resolveObjectType(ref.objectTypeId)
    assertKnownProperties(objectType, properties)
    const primaryId = ontology.getPrimaryPropertyId(ref.objectTypeId)
    const result = { ...properties }
    if (primaryId in result) {
      if (result[primaryId] !== ref.primaryId) {
        throw new Error(
          `[Sixb] Primary property '${primaryId}' must match object identity '${ref.primaryId}'.`
        )
      }
      delete result[primaryId]
    }
    for (const propertyId of Object.keys(result)) {
      const property = objectType.properties.find((candidate) => candidate.id === propertyId)!
      if (property.mode === "telemetry") {
        throw new Error(
          `[Sixb] Static authority cannot write telemetry property '${ref.objectTypeId}.${propertyId}'.`
        )
      }
    }
    validateObjectProperties(objectType, result, ontology.getValueTypesById())
    return result
  })
}

export function validateObjectPatchPropertyIds(
  ontology: OntologyRegistry,
  ref: OntologyObjectRef,
  propertyIds: readonly string[],
  label: "unset" | "reset"
): void {
  materializationValidation(() => {
    const objectType = ontology.resolveObjectType(ref.objectTypeId)
    const primaryId = ontology.getPrimaryPropertyId(ref.objectTypeId)
    for (const propertyId of propertyIds) {
      const property = objectType.properties.find((candidate) => candidate.id === propertyId)
      if (!property) {
        throw new Error(
          `[Sixb] Object patch ${label} references unknown property '${ref.objectTypeId}.${propertyId}'.`
        )
      }
      if (propertyId === primaryId) {
        throw new Error(
          `[Sixb] Object patch ${label} cannot target primary property '${ref.objectTypeId}.${propertyId}'.`
        )
      }
      if (property.mode === "telemetry") {
        throw new Error(
          `[Sixb] Object patch ${label} cannot target telemetry property '${ref.objectTypeId}.${propertyId}'.`
        )
      }
    }
  })
}

export function validateEffectiveObject(
  ontology: OntologyRegistry,
  ref: OntologyObjectRef,
  properties: Readonly<Record<string, JsonValue>>
): void {
  materializationValidation(() => {
    const objectType = ontology.resolveObjectType(ref.objectTypeId)
    assertKnownProperties(objectType, properties)
    for (const property of objectType.properties) {
      if (
        property.mode !== "telemetry" &&
        property.required &&
        properties[property.id] === undefined
      ) {
        throw new Error(
          `[Sixb] Missing required property '${property.id}' for object type '${objectType.id}'`
        )
      }
    }
    validateObjectProperties(objectType, properties, ontology.getValueTypesById())
  })
}

export function validateLinkAuthorityProperties(
  ontology: OntologyRegistry,
  ref: OntologyLinkRef,
  properties: Readonly<Record<string, JsonValue>> | undefined
): Readonly<Record<string, JsonValue>> | undefined {
  return materializationValidation(() => {
    const objectType = ontology.resolveObjectType(ref.source.objectTypeId)
    const link = objectType.links.find((candidate) => candidate.id === ref.linkId)
    if (!link) throw new Error(`[Sixb] Unknown link '${ref.source.objectTypeId}.${ref.linkId}'.`)
    if (!ontology.isValidLinkTarget(link.targetObjectTypeId, ref.target.objectTypeId)) {
      throw new Error(
        `[Sixb] Link '${ref.source.objectTypeId}.${ref.linkId}' cannot target '${ref.target.objectTypeId}'.`
      )
    }
    validateLinkProperties(objectType, link, properties, undefined, ontology.getValueTypesById())
    return properties
  })
}

export function validateTelemetryPoint(
  ontology: OntologyRegistry,
  point: TelemetryPointWrite
): void {
  materializationValidation(() => {
    const objectType = ontology.resolveObjectType(point.series.object.objectTypeId)
    const property = objectType.properties.find(
      (candidate) => candidate.id === point.series.propertyId
    )
    if (!property || property.mode !== "telemetry") {
      throw new Error(
        `[Sixb] Property '${point.series.object.objectTypeId}.${point.series.propertyId}' is not telemetry-enabled.`
      )
    }
    validatePropertyValue(
      property,
      point.value,
      `${objectType.id}.${property.id}`,
      ontology.getValueTypesById()
    )
    validateTelemetryUnit(
      property,
      `${objectType.id}.${property.id}`,
      point.unit,
      ontology.getValueTypesById()
    )
  })
}

function materializationValidation<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof MaterializationValidationError) throw error
    throw new MaterializationValidationError(error instanceof Error ? error.message : String(error))
  }
}
