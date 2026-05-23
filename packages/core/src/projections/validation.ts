/**
 * Build-time validation helpers for projection definitions.
 *
 * These run eagerly inside builder calls (not deferred to `.build()`).
 * They are also reusable by Increment 7 for startup validation.
 */

import type { DatasetDefinition } from "../datasets"
import type { OntologyRegistry } from "../ontology"
import type { ObjectType } from "../ontology/types"
import { ProjectionValidationError } from "./errors"
import type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
} from "./types"

/**
 * Validates the property mapping for an object projection.
 *
 * Rules:
 * 1. All keys must be valid property ids on the object type.
 * 2. The object type must have exactly one primary property.
 * 3. The primary property must be included in the mapping.
 */
export function validatePropertyMapping(
  objectType: ObjectType,
  mapping: Record<string, string>
): void {
  const propertyIds = new Set(objectType.properties.map((p) => p.id))
  const mappingKeys = Object.keys(mapping)

  // Rule 1: all keys are valid property ids
  for (const key of mappingKeys) {
    if (!propertyIds.has(key)) {
      const available = [...propertyIds].sort().join(", ")
      throw new ProjectionValidationError(
        `Property '${key}' does not exist on object type '${objectType.id}'. ` +
          `Available properties: ${available}`
      )
    }
  }

  // Rule 2: exactly one primary property
  const primaryProperties = objectType.properties.filter((p) => p.primary === true)
  if (primaryProperties.length !== 1) {
    throw new ProjectionValidationError(
      `Object type '${objectType.id}' must have exactly one primary property, ` +
        `found ${primaryProperties.length}.`
    )
  }

  // Rule 3: primary property is in the mapping
  const primaryId = primaryProperties[0].id
  if (!(primaryId in mapping)) {
    throw new ProjectionValidationError(
      `Primary property '${primaryId}' of object type '${objectType.id}' ` +
        `must be included in the property mapping.`
    )
  }
}

/**
 * Validates the link mapping for an object projection and returns a validated copy.
 *
 * Rules:
 * 1. All keys must be valid link ids on the object type.
 * 2. Record key must match descriptor.linkId.
 * 3. Link target must be a single concrete type (not polymorphic or wildcard).
 * 4. Source property must exist on the object type.
 * 5. Source property must be present in the property mapping.
 */
export function validateAndLowerLinkMapping(
  objectType: ObjectType,
  linkMapping: Record<string, ForeignKeyDescriptor>,
  propertyMapping: Record<string, string>
): Record<string, ForeignKeyDescriptor> {
  const linkIds = new Set(objectType.links.map((l) => l.id))
  const linksById = new Map(objectType.links.map((l) => [l.id, l]))
  const propertyIds = new Set(objectType.properties.map((p) => p.id))

  for (const [key, descriptor] of Object.entries(linkMapping)) {
    // Rule 1: valid link id
    if (!linkIds.has(key)) {
      const available = [...linkIds].sort().join(", ")
      throw new ProjectionValidationError(
        `Link '${key}' does not exist on object type '${objectType.id}'. ` +
          `Available links: ${available}`
      )
    }

    // Rule 2: key matches descriptor.linkId
    if (key !== descriptor.linkId) {
      throw new ProjectionValidationError(
        `Link mapping key '${key}' does not match descriptor linkId '${descriptor.linkId}'.`
      )
    }

    // Rule 3: single concrete target
    const link = linksById.get(key)!
    if (Array.isArray(link.targetObjectTypeId)) {
      throw new ProjectionValidationError(
        `Link '${key}' on object type '${objectType.id}' has a polymorphic target. ` +
          `FK projection of polymorphic links is not yet supported.`
      )
    }
    if (link.targetObjectTypeId === "*") {
      throw new ProjectionValidationError(
        `Link '${key}' on object type '${objectType.id}' has a wildcard target. ` +
          `FK projection of wildcard links is not supported.`
      )
    }

    // Rule 4: source property exists on the type
    if (!propertyIds.has(descriptor.sourcePropertyId)) {
      const available = [...propertyIds].sort().join(", ")
      throw new ProjectionValidationError(
        `Source property '${descriptor.sourcePropertyId}' does not exist on ` +
          `object type '${objectType.id}'. Available properties: ${available}`
      )
    }

    // Rule 5: source property is in the property mapping
    if (!(descriptor.sourcePropertyId in propertyMapping)) {
      throw new ProjectionValidationError(
        `Source property '${descriptor.sourcePropertyId}' for link '${key}' ` +
          `must be included in the property mapping.`
      )
    }
  }

  return { ...linkMapping }
}

/**
 * Validates that a link token points to a single concrete target type.
 *
 * Rules:
 * 1. Not an array (polymorphic).
 * 2. Not wildcard ("*").
 */
export function validateLinkProjectionTarget(linkToken: {
  readonly id: string
  readonly targetObjectTypeId: string | readonly string[]
}): void {
  if (Array.isArray(linkToken.targetObjectTypeId)) {
    throw new ProjectionValidationError(
      `Link '${linkToken.id}' has a polymorphic target. ` +
        `Link projection of polymorphic links is not yet supported.`
    )
  }
  if (linkToken.targetObjectTypeId === "*") {
    throw new ProjectionValidationError(
      `Link '${linkToken.id}' has a wildcard target. ` +
        `Link projection of wildcard links is not supported.`
    )
  }
}

/**
 * Validates all registered projections against the ontology at startup.
 *
 * For object projections:
 * 1. `datasetId` exists in the dataset registry.
 * 2. `objectTypeId` exists in the type registry.
 * 3. All property mapping keys are valid property ids on the type.
 * 4. All mapped dataset columns exist in the referenced dataset.
 * 5. The primary property is included in the property mapping.
 * 6. FK link descriptors reference valid links, valid source properties (present in mapping),
 *    and valid target types with primaries.
 *
 * For link projections:
 * 1. `datasetId` exists in the dataset registry.
 * 2. Source and target types exist.
 * 3. The link exists on the source type.
 * 4. Source and target fields exist in the referenced dataset.
 * 5. Both source and target types have primary properties.
 */
export function validateProjectionsAtStartup(
  objectProjections: readonly ObjectProjectionDefinition[],
  linkProjections: readonly LinkProjectionDefinition[],
  ontology: OntologyRegistry,
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): void {
  const objectTypesById = ontology.getObjectTypesById()
  const primaryByTypeId = ontology.getPrimaryByTypeId()

  for (const projection of objectProjections) {
    const prefix = `Projection "${projection.id}"`
    const dataset = datasetsById.get(projection.datasetId)
    if (!dataset) {
      throw new ProjectionValidationError(
        `${prefix}: unknown dataset "${projection.datasetId}". ` +
          `Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }

    const objectType = objectTypesById.get(projection.objectTypeId)
    if (!objectType) {
      throw new ProjectionValidationError(
        `${prefix}: unknown object type "${projection.objectTypeId}"`
      )
    }

    const datasetColumnNames = new Set(dataset.schema.columns.map((column) => column.name))
    const propertyIds = new Set(objectType.properties.map((p) => p.id))
    for (const [propId, columnName] of Object.entries(projection.properties)) {
      if (!propertyIds.has(propId)) {
        throw new ProjectionValidationError(
          `${prefix}: unknown property "${propId}" on type "${projection.objectTypeId}"`
        )
      }
      if (!datasetColumnNames.has(columnName)) {
        throw new ProjectionValidationError(
          `${prefix}: property "${propId}" references unknown dataset column "${columnName}" ` +
            `on dataset "${projection.datasetId}"`
        )
      }
    }

    const primaryId = primaryByTypeId.get(projection.objectTypeId)!
    if (!(primaryId in projection.properties)) {
      throw new ProjectionValidationError(
        `${prefix}: primary property "${primaryId}" must be in property mapping`
      )
    }

    const linkIds = new Set(objectType.links.map((l) => l.id))
    for (const [linkId, fk] of Object.entries(projection.links)) {
      if (!linkIds.has(linkId)) {
        throw new ProjectionValidationError(
          `${prefix}: FK link "${linkId}" references unknown link on type "${projection.objectTypeId}"`
        )
      }
      if (!propertyIds.has(fk.sourcePropertyId)) {
        throw new ProjectionValidationError(
          `${prefix}: FK link "${linkId}" source property "${fk.sourcePropertyId}" does not exist on type "${projection.objectTypeId}"`
        )
      }
      if (!(fk.sourcePropertyId in projection.properties)) {
        throw new ProjectionValidationError(
          `${prefix}: FK link "${linkId}" source property "${fk.sourcePropertyId}" must be in property mapping`
        )
      }
      if (!objectTypesById.has(fk.targetObjectTypeId)) {
        throw new ProjectionValidationError(
          `${prefix}: FK link "${linkId}" target type "${fk.targetObjectTypeId}" is unknown`
        )
      }
      if (!primaryByTypeId.has(fk.targetObjectTypeId)) {
        throw new ProjectionValidationError(
          `${prefix}: FK link "${linkId}" target type "${fk.targetObjectTypeId}" has no primary property`
        )
      }
    }
  }

  for (const projection of linkProjections) {
    const prefix = `Projection "${projection.id}"`
    const dataset = datasetsById.get(projection.datasetId)
    if (!dataset) {
      throw new ProjectionValidationError(
        `${prefix}: unknown dataset "${projection.datasetId}". ` +
          `Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }

    if (!objectTypesById.has(projection.sourceObjectTypeId)) {
      throw new ProjectionValidationError(
        `${prefix}: unknown source type "${projection.sourceObjectTypeId}"`
      )
    }
    if (!objectTypesById.has(projection.targetObjectTypeId)) {
      throw new ProjectionValidationError(
        `${prefix}: unknown target type "${projection.targetObjectTypeId}"`
      )
    }
    const sourceType = objectTypesById.get(projection.sourceObjectTypeId)!
    const linkIds = new Set(sourceType.links.map((l) => l.id))
    if (!linkIds.has(projection.linkId)) {
      throw new ProjectionValidationError(
        `${prefix}: link "${projection.linkId}" does not exist on source type "${projection.sourceObjectTypeId}"`
      )
    }
    const datasetColumnNames = new Set(dataset.schema.columns.map((column) => column.name))
    if (!datasetColumnNames.has(projection.sourceField)) {
      throw new ProjectionValidationError(
        `${prefix}: source field "${projection.sourceField}" references unknown dataset column ` +
          `"${projection.sourceField}" on dataset "${projection.datasetId}"`
      )
    }
    if (!datasetColumnNames.has(projection.targetField)) {
      throw new ProjectionValidationError(
        `${prefix}: target field "${projection.targetField}" references unknown dataset column ` +
          `"${projection.targetField}" on dataset "${projection.datasetId}"`
      )
    }
    if (!primaryByTypeId.has(projection.sourceObjectTypeId)) {
      throw new ProjectionValidationError(
        `${prefix}: source type "${projection.sourceObjectTypeId}" has no primary property`
      )
    }
    if (!primaryByTypeId.has(projection.targetObjectTypeId)) {
      throw new ProjectionValidationError(
        `${prefix}: target type "${projection.targetObjectTypeId}" has no primary property`
      )
    }
  }
}
