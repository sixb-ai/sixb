/**
 * Leaf operation: remove a single link.
 */
import { assertPrivileged } from "../../authorization"
import { buildLinkDeletedEvent } from "../../events"
import { assertLinkTargetType } from "../../ontology/validation"
import type { ResolvedLinkContext } from "../context"
import { ObjectError } from "../errors"

export async function removeLink(
  ctx: ResolvedLinkContext,
  params: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }
): Promise<void> {
  assertPrivileged(ctx, "removeLink")
  const { events, storage, objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId } = params

  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, (expected, actual) =>
    ontology.isValidLinkTarget(expected, actual)
  )

  const appended = await events.append({
    events: [
      buildLinkDeletedEvent({
        sourceTypeId: objectType.id,
        sourceId,
        linkId,
        targetTypeId,
        targetId,
      }),
    ],
  })

  const [event] = appended
  if (!event || event.type !== "link.deleted") {
    throw new ObjectError("Failed to append link deletion event")
  }

  await storage.objects.applyLinkDelete(event)
}
