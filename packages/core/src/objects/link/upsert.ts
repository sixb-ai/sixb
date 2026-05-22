/**
 * Leaf operation: upsert a single link.
 */
import { OntologyValidationError } from "../../ontology/errors"
import { assertLinkTargetType, validateLinkProperties } from "../../ontology/validation"
import type { ResolvedLinkContext } from "../context"
import { ObjectError } from "../errors"
import { requireObject } from "../helpers"

export async function upsertLink(
  ctx: ResolvedLinkContext,
  params: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
  }
): Promise<void> {
  const { events, storage, projectId, objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId, properties } = params

  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, (expected, actual) =>
    ontology.isValidLinkTarget(expected, actual)
  )

  await requireObject(storage, projectId, objectType.id, sourceId, "Source object not found")
  await requireObject(storage, projectId, targetTypeId, targetId, "Target object not found")

  const existingLinks = await storage.objects.listLinks({
    projectId,
    sourceTypeId: objectType.id,
    sourceId,
    linkId,
  })

  const sameLink = existingLinks.find(
    (existing) => existing.targetTypeId === targetTypeId && existing.targetId === targetId
  )

  validateLinkProperties(
    objectType,
    linkDefinition,
    properties,
    sameLink?.properties,
    ontology.getValueTypesById()
  )

  if (linkDefinition.cardinality === "one") {
    const conflicting = existingLinks.find(
      (existing) => existing.targetTypeId !== targetTypeId || existing.targetId !== targetId
    )

    if (conflicting) {
      throw new OntologyValidationError(
        `Link ${objectType.id}.${linkId} has cardinality 'one'` +
          ` and already points to ${conflicting.targetTypeId}:${conflicting.targetId}`
      )
    }
  }

  const appended = await events.append({
    events: [
      {
        type: "link.upserted",
        payload: {
          sourceTypeId: objectType.id,
          sourceId,
          linkId,
          targetTypeId,
          targetId,
          ...(properties !== undefined ? { properties } : {}),
        },
      },
    ],
  })

  const event = appended[0]
  if (!event || event.type !== "link.upserted") {
    throw new ObjectError("Failed to append link.upserted event")
  }

  await storage.objects.applyLinkUpserted(event)
}
