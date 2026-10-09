import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectType, Property } from "../ontology/types"
import { SecurityValidationError } from "./errors"

/**
 * Check every property marking against the registered markings once at startup.
 *
 * A marking is enforced at read time from the property definition alone, so each rule here closes
 * a path that would otherwise return the value unredacted or make enforcement ambiguous.
 */
export function validatePropertyMarkingsAtStartup(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly markingIds: ReadonlySet<string>
}): void {
  for (const objectType of input.ontology.listObjectTypes()) {
    for (const property of objectType.properties) {
      validatePropertyMarkings(objectType, property, input.markingIds)
    }
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) {
        if (property.markings !== undefined) {
          throw new SecurityValidationError(
            `[Sixb] Link property '${objectType.id}.${link.id}.${property.id}' cannot carry markings. Mark object properties instead.`
          )
        }
      }
    }
    assertSubtypeKeepsParentMarkings(objectType, input.ontology)
  }
}

function validatePropertyMarkings(
  objectType: ObjectType,
  property: Property,
  markingIds: ReadonlySet<string>
): void {
  const markings = property.markings
  if (markings === undefined) return
  const path = `${objectType.id}.${property.id}`

  if (!Array.isArray(markings) || markings.length === 0) {
    throw new SecurityValidationError(
      `[Sixb] Property '${path}' markings must be a non-empty list of marking ids.`
    )
  }
  if (new Set(markings).size !== markings.length) {
    throw new SecurityValidationError(`[Sixb] Property '${path}' lists the same marking twice.`)
  }
  for (const markingId of markings) {
    if (typeof markingId !== "string" || !markingIds.has(markingId)) {
      throw new SecurityValidationError(
        `[Sixb] Property '${path}' references unknown marking '${String(markingId)}'. Add it to 'security/markings/' or pass it to createSixb({ markings }).`
      )
    }
  }
  // The primary id identifies the object in every response, link, and event.
  if (property.primary) {
    throw new SecurityValidationError(
      `[Sixb] Primary property '${path}' cannot carry markings: it identifies the object.`
    )
  }
  // Telemetry values also flow through history reads and telemetry events, which do not
  // enforce markings yet.
  if (property.mode === "telemetry") {
    throw new SecurityValidationError(
      `[Sixb] Telemetry property '${path}' cannot carry markings yet.`
    )
  }
}

/**
 * A subtype inherits its parent's properties and may redefine them. Subtype rows are returned by
 * parent-type reads, so a redefinition that dropped a marking would declassify the parent's data.
 */
function assertSubtypeKeepsParentMarkings(
  objectType: ObjectType,
  ontology: OntologyDefinitionCatalog
): void {
  if (!objectType.extends) return
  const parent = ontology.getObjectTypeById(objectType.extends)
  if (!parent) return

  for (const parentProperty of parent.properties) {
    const property = objectType.properties.find((candidate) => candidate.id === parentProperty.id)
    const markings = new Set(property?.markings ?? [])
    const missing = (parentProperty.markings ?? []).filter((markingId) => !markings.has(markingId))
    if (missing.length > 0) {
      throw new SecurityValidationError(
        `[Sixb] Property '${objectType.id}.${parentProperty.id}' must keep the markings of '${parent.id}.${parentProperty.id}': add ${missing.map((markingId) => `'${markingId}'`).join(", ")}.`
      )
    }
  }
}
