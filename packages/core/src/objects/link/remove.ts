/**
 * Leaf operation: remove a single link.
 */
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
  const { events, storage, objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId } = params

  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, (expected, actual) =>
    ontology.isValidLinkTarget(expected, actual)
  )

  const appended = await events.append({
    events: [
      {
        type: "link.removed",
        payload: {
          sourceTypeId: objectType.id,
          sourceId,
          linkId,
          targetTypeId,
          targetId,
        },
      },
    ],
  })

  const event = appended[0]
  if (!event || event.type !== "link.removed") {
    throw new ObjectError("Failed to append link.removed event")
  }

  await storage.objects.applyLinkRemoved(event)
}
