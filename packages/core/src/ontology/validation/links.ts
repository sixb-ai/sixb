import type { ObjectLink, ValueType } from ".."
import { OntologyValidationError } from "../errors"
import type { ObjectTypeWithPropertyTokens } from "../tokens"
import { validatePropertyValue } from "./properties"

/**
 * Assert that `targetTypeId` is compatible with the link definition's declared target.
 *
 * When `isValidLinkTarget` is provided (e.g. for polymorphic subtype checks),
 * it is used instead of strict equality.
 */
export function assertLinkTargetType(
  objectTypeId: string,
  linkId: string,
  linkDefinition: ObjectLink,
  targetTypeId: string,
  isValidLinkTarget?: (expected: string | string[], actual: string) => boolean
): void {
  const valid = isValidLinkTarget
    ? isValidLinkTarget(linkDefinition.targetObjectTypeId, targetTypeId)
    : targetTypeId === linkDefinition.targetObjectTypeId
  if (!valid) {
    const expected = Array.isArray(linkDefinition.targetObjectTypeId)
      ? linkDefinition.targetObjectTypeId.join(" | ")
      : linkDefinition.targetObjectTypeId
    throw new OntologyValidationError(
      `[Pario] Link ${objectTypeId}.${linkId} must target '${expected}', got '${targetTypeId}'`
    )
  }
}

/**
 * Verify that `actualTarget` is either the same as or a subtype of the
 * link's declared `targetObjectTypeId`. Throws on mismatch.
 */
export function assertTargetTypeCompatible(
  getSubTypes: (typeId: string) => string[],
  declaredTarget: string | string[],
  actualTarget: string,
  context: string
): void {
  if (declaredTarget === "*") return
  const types = Array.isArray(declaredTarget) ? declaredTarget : [declaredTarget]
  if (types.includes("*")) return
  for (const type of types) {
    if (actualTarget === type || getSubTypes(type).includes(actualTarget)) return
  }
  const expected = types.join(" | ")
  throw new OntologyValidationError(
    `[Pario] ${context}: target type '${actualTarget}' is not compatible with declared target '${expected}'`
  )
}

export function validateLinkProperties(
  objectType: ObjectTypeWithPropertyTokens,
  link: ObjectLink,
  properties: Record<string, unknown> | undefined,
  existingProperties: Record<string, unknown> | undefined,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const linkProperties = link.properties ?? []
  const provided = properties ?? {}

  if (linkProperties.length === 0) {
    if (Object.keys(provided).length > 0) {
      throw new OntologyValidationError(
        `[Pario] Link ${objectType.id}.${link.id} does not define link properties`
      )
    }
    return
  }

  const knownPropertyIds = new Set(linkProperties.map((property) => property.id))
  for (const propertyId of Object.keys(provided)) {
    if (!knownPropertyIds.has(propertyId)) {
      throw new OntologyValidationError(
        `[Pario] Unknown link property '${propertyId}' for link '${objectType.id}.${link.id}'`
      )
    }
  }

  for (const [propertyId, value] of Object.entries(provided)) {
    const property = linkProperties.find((candidate) => candidate.id === propertyId)
    if (!property) {
      continue
    }

    validatePropertyValue(
      property,
      value,
      `${objectType.id}.${link.id}.${propertyId}`,
      valueTypesById
    )
  }

  // Required checks run against merged state so partial link updates are valid.
  const merged = {
    ...(existingProperties ?? {}),
    ...provided,
  }

  for (const property of linkProperties) {
    if (property.required && merged[property.id] === undefined) {
      throw new OntologyValidationError(
        `[Pario] Missing required link property '${property.id}' for link '${objectType.id}.${link.id}'`
      )
    }
  }
}
