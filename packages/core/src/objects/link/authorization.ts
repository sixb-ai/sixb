/**
 * The authorization rule for writing a link, in one place because all three link leaves need it.
 */
import { assertAuthorized } from "../../authorization"
import type { SixbRuntimeContext } from "../../runtime/types"
import { assertCanEditType } from "../conditional-writes"

interface LinkWrite {
  readonly sourceTypeId: string
  readonly linkId: string
  readonly targetTypeId: string
}

/**
 * Assert a principal may create or remove these links.
 *
 * `edit` on the **source** type, `view` on the **target**: a link is declared on the source type
 * (`objectType.links`), and writing one changes the source's edges, not the target's properties.
 * Requiring `edit` on the target too would mean a clerk needs write access to every customer before
 * attaching an invoice to one.
 *
 * `view` on the target is still required, and for two reasons: it matches how links are *read* —
 * `canViewLink` already demands `view` on both endpoints — and without it the endpoint-existence
 * check that follows would answer whether a target the principal cannot see exists.
 *
 * Call this *before* any endpoint lookup, for that second reason.
 *
 * A view through a condition counts for either end: the endpoint lookup then reads each object of
 * such a type through the writer's reader, and one it cannot see is not found.
 */
export async function assertCanWriteLinks(
  ctx: Pick<
    SixbRuntimeContext,
    "projectId" | "runtimeAuthorization" | "authorization" | "objectReader"
  >,
  writes: readonly LinkWrite[]
): Promise<void> {
  for (const write of writes) {
    await assertCanEditType(ctx, write.sourceTypeId)

    if (ctx.objectReader.viewsThroughCondition(write.targetTypeId)) {
      await ctx.objectReader.assertViewable([write.targetTypeId])
    } else {
      assertAuthorized(ctx, { kind: "object.view", objectTypeId: write.targetTypeId })
    }
  }

  // An endpoint type or a link the reader cannot read under the markings of the versions
  // projections applied is refused like one it has no view grant for, for the same reason.
  await ctx.objectReader.assertReadable({
    objectTypeIds: [
      ...new Set(writes.flatMap((write) => [write.sourceTypeId, write.targetTypeId])),
    ],
    links: writes.map((write) => ({ objectTypeId: write.sourceTypeId, linkId: write.linkId })),
  })
}
