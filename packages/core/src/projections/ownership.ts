import { compareStrings } from "../json"
import type { ProjectionOwnership } from "../materializer/types"
import type { OntologyRegistry } from "../ontology"
import { ProjectionValidationError } from "./errors"
import type { ProjectionDefinition } from "./types"

export function computeProjectionOwnership(
  projection: ProjectionDefinition,
  ontology: OntologyRegistry
): ProjectionOwnership {
  if (projection._tag === "ObjectProjectionDefinition") {
    const primaryId = ontology.getPrimaryPropertyId(projection.objectTypeId)
    return freezeOwnership({
      objects: [
        {
          objectTypeId: projection.objectTypeId,
          existence: true,
          propertyIds: Object.keys(projection.properties)
            .filter((propertyId) => propertyId !== primaryId)
            .sort(compareStrings),
        },
      ],
      links: Object.keys(projection.links)
        .sort(compareStrings)
        .map((linkId) => ({ sourceObjectTypeId: projection.objectTypeId, linkId })),
      telemetry: [],
    })
  }

  if (projection._tag === "LinkProjectionDefinition") {
    return freezeOwnership({
      objects: [],
      links: [
        {
          sourceObjectTypeId: projection.sourceObjectTypeId,
          linkId: projection.linkId,
        },
      ],
      telemetry: [],
    })
  }

  return freezeOwnership({
    objects: [],
    links: [],
    telemetry: [
      {
        objectTypeId: projection.objectTypeId,
        propertyId: projection.propertyId,
      },
    ],
  })
}

export function validateProjectionOwnership(
  projections: readonly ProjectionDefinition[],
  ontology: OntologyRegistry
): void {
  const existenceOwners = new Map<string, string>()
  const propertyOwners = new Map<string, string>()
  const linkOwners = new Map<string, string>()
  const telemetryOwners = new Map<string, string>()

  for (const projection of projections) {
    const ownership = computeProjectionOwnership(projection, ontology)
    for (const object of ownership.objects) {
      if (object.existence) {
        registerOwner(
          existenceOwners,
          object.objectTypeId,
          projection.id,
          `object type '${object.objectTypeId}' existence`
        )
      }
      for (const propertyId of object.propertyIds) {
        registerOwner(
          propertyOwners,
          JSON.stringify([object.objectTypeId, propertyId]),
          projection.id,
          `property '${object.objectTypeId}.${propertyId}'`
        )
      }
    }
    for (const link of ownership.links) {
      registerOwner(
        linkOwners,
        JSON.stringify([link.sourceObjectTypeId, link.linkId]),
        projection.id,
        `link scope '${link.sourceObjectTypeId}.${link.linkId}'`
      )
    }
    for (const telemetry of ownership.telemetry) {
      registerOwner(
        telemetryOwners,
        JSON.stringify([telemetry.objectTypeId, telemetry.propertyId]),
        projection.id,
        `telemetry source '${telemetry.objectTypeId}.${telemetry.propertyId}'`
      )
    }
  }
}

function registerOwner(
  owners: Map<string, string>,
  key: string,
  projectionId: string,
  description: string
): void {
  const existing = owners.get(key)
  if (existing !== undefined) {
    throw new ProjectionValidationError(
      `[Sixb] Projection '${projectionId}' overlaps ${description} owned by projection '${existing}'.`
    )
  }
  owners.set(key, projectionId)
}

function freezeOwnership(ownership: ProjectionOwnership): ProjectionOwnership {
  return Object.freeze({
    objects: Object.freeze(
      ownership.objects.map((object) =>
        Object.freeze({ ...object, propertyIds: Object.freeze([...object.propertyIds]) })
      )
    ),
    links: Object.freeze(ownership.links.map((link) => Object.freeze({ ...link }))),
    telemetry: Object.freeze(
      ownership.telemetry.map((telemetry) => Object.freeze({ ...telemetry }))
    ),
  })
}
