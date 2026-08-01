/**
 * Leaf operation: remove a single link through the ontology Materializer.
 */
import { assertLinkTargetType } from "../../ontology/validation"
import type { ResolvedLinkContext } from "../context"
import {
  commitRuntimeOperations,
  linkDeleteOperation,
  runtimeOperationId,
} from "../materializer-adapter"
import { assertCanWriteLink } from "./authorization"

export async function removeLink(
  ctx: ResolvedLinkContext,
  params: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }
): Promise<void> {
  const { objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId } = params
  assertCanWriteLink(ctx, { sourceTypeId: objectType.id, targetTypeId })

  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, (expected, actual) =>
    ontology.isValidLinkTarget(expected, actual)
  )

  // A missing link is a no-op: the delete records managed authority only when an effective edge
  // exists, so the commit reports `unchanged` instead of failing.
  await commitRuntimeOperations(ctx, [
    linkDeleteOperation({
      id: runtimeOperationId(0),
      ref: {
        source: { objectTypeId: objectType.id, primaryId: sourceId },
        linkId,
        target: { objectTypeId: targetTypeId, primaryId: targetId },
      },
    }),
  ])
}
