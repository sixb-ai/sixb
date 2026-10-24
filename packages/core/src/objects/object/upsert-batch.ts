/**
 * Leaf operation: batch upsert objects of a single type through the ontology Materializer.
 *
 * Everything that survives local normalization is submitted as one ordered continue-mode commit, so
 * later items observe earlier ones and a provider failure rolls the whole batch back.
 */
import { stableJsonStringify } from "../../json"
import type { BatchItemResult } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import {
  assertCanEditType,
  expectSeen,
  findWrittenObjects,
  writeFoundObject,
} from "../conditional-writes"
import type { ResolvedObjectContext } from "../context"
import {
  type NormalizedRuntimeObject,
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
  await assertCanEditType(ctx, ctx.objectType.id)
  const { objectType, primaryPropertyId, ontology } = ctx
  const valueTypesById = ontology.getValueTypesById()
  const redact = await ctx.objectReader.writtenRowRedactor(objectType.id)
  const checkUniqueValues = await ctx.objectReader.uniqueValueWriteCheck(objectType.id)

  // Normalized up front, so that a writer viewing the type through a condition looks up every id
  // in one read. An item that fails here still fails at its own position.
  const normalized = items.map((item): NormalizedRuntimeObject | { readonly error: unknown } => {
    try {
      const object = normalizeRuntimeObject({
        objectType,
        primaryPropertyId,
        properties: item.properties,
        valueTypesById,
      })
      // Fails this item alone, whatever objects hold: a refusal as taken would answer per value.
      checkUniqueValues(object.properties)
      return object
    } catch (error) {
      return { error }
    }
  })

  const found = ctx.objectReader.viewsThroughCondition(objectType.id)
    ? await findWrittenObjects(
        ctx,
        objectType.id,
        normalized.flatMap((object) => ("error" in object ? [] : [object.primaryId]))
      )
    : undefined

  return runRuntimeItemBatch({
    ctx,
    items,
    ...(found === undefined ? {} : { expectedObjects: expectSeen(found.values()) }),
    plan(_item, index) {
      const object = normalized[index]!
      if ("error" in object) throw object.error

      const ref = { objectTypeId: objectType.id, primaryId: object.primaryId }
      const write = { id: runtimeOperationId(index), ref, properties: object.properties }
      return {
        // One commit resolves one authority state per object, so two items for the same identity are
        // unambiguous only when they ask for the same thing.
        key: `${ref.objectTypeId}:${ref.primaryId}`,
        label: `object '${ref.objectTypeId}:${ref.primaryId}'`,
        fingerprint: stableJsonStringify(object.properties),
        operations: [
          found === undefined
            ? objectUpsertOperation(write)
            : writeFoundObject({ ...write, primaryPropertyId, found: found.get(ref.primaryId) }),
        ],
      }
    },
    value: ([outcome]) => redact(toObjectRow(ctx.projectId, requireEffectiveObject(outcome))),
  })
}
