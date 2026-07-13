/**
 * Leaf operation: upsert a single link.
 */
import { assertPrivileged } from "../../authorization"
import { buildLinkUpsertEvent } from "../../events"
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
  assertPrivileged(ctx, "upsertLink")
  const { events, storage, projectId, objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId, properties } = params

  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, (expected, actual) =>
    ontology.isValidLinkTarget(expected, actual)
  )

  await requireObject(storage, projectId, objectType.id, sourceId, "Source object not found")
  await requireObject(storage, projectId, targetTypeId, targetId, "Target object not found")

  const existingLinks = await storage.objects.listLinks({
    projectId,
    objectTypeId: objectType.id,
    objectId: sourceId,
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

  const mergedProperties =
    properties !== undefined || sameLink?.properties !== undefined
      ? {
          ...(sameLink?.properties ?? {}),
          ...(properties ?? {}),
        }
      : undefined

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
      buildLinkUpsertEvent({
        sourceTypeId: objectType.id,
        sourceId,
        linkId,
        targetTypeId,
        targetId,
        operation: sameLink ? "update" : "create",
        previousProperties: sameLink?.properties,
        ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
      }),
    ],
  })

  const [event] = appended
  if (!event || (event.type !== "link.created" && event.type !== "link.updated")) {
    throw new ObjectError("Failed to append link mutation event")
  }

  await storage.objects.applyLinkUpsert(event)
}
