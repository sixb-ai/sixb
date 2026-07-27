/**
 * Leaf operation: upsert a single object through the ontology Materializer.
 */

import { assertPrivileged } from "../../authorization"
import type { ObjectRow } from "../../storage"
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
  assertPrivileged(ctx, "upsertObject")
  const { objectType, primaryPropertyId, ontology } = ctx

  const normalized = normalizeRuntimeObject({
    objectType,
    primaryPropertyId,
    properties,
    valueTypesById: ontology.getValueTypesById(),
  })
  const ref = { objectTypeId: objectType.id, primaryId: normalized.primaryId }

  // The Materializer classifies this as an independent create, a patch over source authority, or a
  // restore plus patch inside its own transaction.
  const commit = await commitRuntimeOperations(ctx, [
    objectUpsertOperation({ id: runtimeOperationId(0), ref, properties: normalized.properties }),
  ])
  return toObjectRow(ctx.projectId, requireEffectiveObject(commit.outcomes[0]))
}
