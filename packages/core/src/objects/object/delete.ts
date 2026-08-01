/**
 * Leaf operations: delete and restore a single object through the ontology Materializer.
 *
 * Both are thin wrappers over one materializer operation, exactly like `removeLink` — the cascade
 * over links and the effective-state bookkeeping happen inside the commit.
 */
import { assertCanEdit } from "../../authorization"
import type { ResolvedObjectContext } from "../context"
import {
  commitRuntimeOperations,
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
  assertCanEdit(ctx, ctx.objectType.id)
  await commitRuntimeOperations(ctx, [
    objectDeleteOperation({
      id: runtimeOperationId(0),
      ref: { objectTypeId: ctx.objectType.id, primaryId },
    }),
  ])
}

/**
 * Withdraw a previous delete.
 *
 * For an object written only from code this is a no-op — there is nothing left to reveal, so write it
 * again instead. For an object a projection also writes, it makes the projected state visible again.
 */
export async function restoreObject(ctx: ResolvedObjectContext, primaryId: string): Promise<void> {
  assertCanEdit(ctx, ctx.objectType.id)
  await commitRuntimeOperations(ctx, [
    objectRestoreOperation({
      id: runtimeOperationId(0),
      ref: { objectTypeId: ctx.objectType.id, primaryId },
    }),
  ])
}
