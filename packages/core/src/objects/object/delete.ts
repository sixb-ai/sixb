/**
 * Leaf operations: delete and restore a single object through the ontology Materializer.
 *
 * Both are thin wrappers over one materializer operation, exactly like `removeLink` — the cascade
 * over links and the effective-state bookkeeping happen inside the commit.
 */
import { assertCanEdit } from "../../authorization"
import type { ExpectedObjectRevision } from "../../materialization/model"
import { assertCanEditType } from "../conditional-writes"
import type { ResolvedObjectContext } from "../context"
import {
  commitRuntimeOperations,
  expectedRevision,
  objectDeleteOperation,
  objectRestoreOperation,
  runtimeOperationId,
} from "../materializer-adapter"

/**
 * Delete the object with this primary id.
 *
 * A missing object is a no-op: the delete records managed authority only where effective state
 * exists, so the commit reports `unchanged` rather than failing. An object a projection also writes
 * stays hidden even while the projection keeps asserting it — `restore()` is what reveals it again.
 */
export async function deleteObject(ctx: ResolvedObjectContext, primaryId: string): Promise<void> {
  await assertCanEditType(ctx, ctx.objectType.id)
  await ctx.objectReader.assertReadable({ objectTypeIds: [ctx.objectType.id] })
  const ref = { objectTypeId: ctx.objectType.id, primaryId }

  // A writer that views the type through a condition deletes only an object it sees, as it is: a
  // hidden one is deleted as a missing one is, not at all.
  let expected: ExpectedObjectRevision[] = []
  if (ctx.objectReader.viewsThroughCondition(ref.objectTypeId)) {
    const seen = await ctx.objectReader.getByPrimaryId(ref)
    if (!seen) return

    expected = [expectedRevision(seen)]
  }

  await commitRuntimeOperations(
    ctx,
    [objectDeleteOperation({ id: runtimeOperationId(0), ref })],
    expected
  )
}

/**
 * Withdraw a previous delete.
 *
 * For an object written only from code this is a no-op — there is nothing left to reveal, so write it
 * again instead. For an object a projection also writes, it makes the projected state visible again.
 *
 * It requires a view of every object of the type: no reader sees a deleted object, so none can
 * show that a condition matches the one it would reveal.
 */
export async function restoreObject(ctx: ResolvedObjectContext, primaryId: string): Promise<void> {
  assertCanEdit(ctx, ctx.objectType.id)
  await ctx.objectReader.assertReadable({ objectTypeIds: [ctx.objectType.id] })
  await commitRuntimeOperations(ctx, [
    objectRestoreOperation({
      id: runtimeOperationId(0),
      ref: { objectTypeId: ctx.objectType.id, primaryId },
    }),
  ])
}
