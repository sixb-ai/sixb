/**
 * Leaf operation: upsert a single object through the ontology Materializer.
 */

import type { ObjectRow } from "../../storage"
import {
  assertCanEditType,
  expectSeen,
  findWrittenObjects,
  writeFoundObject,
} from "../conditional-writes"
import type { ResolvedObjectContext } from "../context"
import {
  commitRuntimeOperations,
  normalizeRuntimeObject,
  objectUpsertOperation,
  requireEffectiveObject,
  runtimeOperationId,
  toObjectRow,
} from "../materializer-adapter"

export async function upsertObject(
  ctx: ResolvedObjectContext,
  properties: Record<string, unknown>
): Promise<ObjectRow> {
  await assertCanEditType(ctx, ctx.objectType.id)
  const { objectType, primaryPropertyId, ontology } = ctx
  const redact = await ctx.objectReader.writtenRowRedactor(objectType.id)
  const checkUniqueValues = await ctx.objectReader.uniqueValueWriteCheck(objectType.id)

  const normalized = normalizeRuntimeObject({
    objectType,
    primaryPropertyId,
    properties,
    valueTypesById: ontology.getValueTypesById(),
  })
  checkUniqueValues(normalized.properties)
  const ref = { objectTypeId: objectType.id, primaryId: normalized.primaryId }
  const write = { id: runtimeOperationId(0), ref, properties: normalized.properties }

  if (ctx.objectReader.viewsThroughCondition(objectType.id)) {
    // Only an object the writer sees is updated. Anything else is a create, which returns the row
    // as sent: no value of an object the writer did not see is merged into it.
    const found = await findWrittenObjects(ctx, objectType.id, [ref.primaryId])
    const commit = await commitRuntimeOperations(
      ctx,
      [writeFoundObject({ ...write, primaryPropertyId, found: found.get(ref.primaryId) })],
      expectSeen(found.values())
    )
    return redact(toObjectRow(ctx.projectId, requireEffectiveObject(commit.outcomes[0])))
  }

  // The Materializer classifies this as an independent create, a patch over source authority, or a
  // restore plus patch inside its own transaction.
  const commit = await commitRuntimeOperations(ctx, [objectUpsertOperation(write)])
  return redact(toObjectRow(ctx.projectId, requireEffectiveObject(commit.outcomes[0])))
}
