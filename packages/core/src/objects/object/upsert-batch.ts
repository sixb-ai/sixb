/**
 * Leaf operation: batch upsert objects of a single type through the ontology Materializer.
 *
 * Everything that survives local normalization is submitted as one ordered continue-mode commit, so
 * later items observe earlier ones and a provider failure rolls the whole batch back.
 */
import { assertPrivileged } from "../../authorization"
import { stableJsonStringify } from "../../json"
import type { BatchItemResult } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import type { ResolvedObjectContext } from "../context"
import {
  normalizeRuntimeObject,
  objectUpsertOperation,
  requireEffectiveObject,
  runtimeOperationId,
  toObjectRow,
} from "../materializer-adapter"
import { runRuntimeItemBatch } from "../runtime-batch"

export async function upsertObjectBatch(
  ctx: ResolvedObjectContext,
  items: readonly { properties: Record<string, unknown> }[]
): Promise<readonly BatchItemResult<ObjectRow>[]> {
  assertPrivileged(ctx, "upsertObjectBatch")
  const { objectType, primaryPropertyId, ontology } = ctx
  const valueTypesById = ontology.getValueTypesById()

  return runRuntimeItemBatch({
    ctx,
    items,
    plan(item, index) {
      const normalized = normalizeRuntimeObject({
        objectType,
        primaryPropertyId,
        properties: item.properties,
        valueTypesById,
      })
      const ref = { objectTypeId: objectType.id, primaryId: normalized.primaryId }
      return {
        // One commit resolves one authority state per object, so two items for the same identity are
        // unambiguous only when they ask for the same thing.
        key: `${ref.objectTypeId}:${ref.primaryId}`,
        label: `object '${ref.objectTypeId}:${ref.primaryId}'`,
        fingerprint: stableJsonStringify(normalized.properties),
        operations: [
          objectUpsertOperation({
            id: runtimeOperationId(index),
            ref,
            properties: normalized.properties,
          }),
        ],
      }
    },
    value: ([outcome]) => toObjectRow(ctx.projectId, requireEffectiveObject(outcome)),
  })
}
