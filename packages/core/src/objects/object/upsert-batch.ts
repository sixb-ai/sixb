/**
 * Leaf operation: batch upsert objects of a single type.
 */
import { assertPrivileged } from "../../authorization"
import type { NewDomainEvent } from "../../events"
import { validateObjectBatch } from "../../ontology/validation"
import type { BatchItemResult } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import type { ResolvedObjectContext } from "../context"

export async function upsertObjectBatch(
  ctx: ResolvedObjectContext,
  items: readonly { properties: Record<string, unknown> }[]
): Promise<readonly BatchItemResult<ObjectRow>[]> {
  assertPrivileged(ctx, "upsertObjectBatch")
  const { events: eventsRuntime, storage, projectId, objectType, primaryPropertyId, ontology } = ctx

  if (items.length === 0) return []

  const results: BatchItemResult<ObjectRow>[] = new Array(items.length)

  // Storage lookup (needed for merge before required-properties check)
  const batchLookupItems = items.flatMap((item) => {
    const primaryId = item.properties[primaryPropertyId]
    if (primaryId === undefined || primaryId === null) return []
    return [{ objectTypeId: objectType.id, primaryId: String(primaryId) }]
  })
  const existingMap = await storage.objects.getByPrimaryIdBatch({
    projectId,
    items: batchLookupItems,
  })

  // Ontology validation (single call)
  const validation = validateObjectBatch(
    objectType,
    primaryPropertyId,
    items,
    existingMap,
    ontology.getValueTypesById()
  )
  for (const { index, error } of validation.errors) results[index] = { ok: false, error }
  if (validation.valid.length === 0) return results

  // Append events, then project the stored events into object storage.
  const events: NewDomainEvent[] = validation.valid.map(({ item }) => ({
    type: "object.upserted",
    payload: {
      objectTypeId: objectType.id,
      primaryId: item.primaryId,
      properties: item.properties,
    },
  }))

  const appended = await eventsRuntime.append({ events })
  const objectEvents = appended.filter(
    (e): e is Extract<typeof e, { type: "object.upserted" }> => e.type === "object.upserted"
  )

  const rows = await storage.objects.applyObjectUpsertedBatch(objectEvents)

  for (let i = 0; i < validation.valid.length; i++) {
    results[validation.valid[i].index] = { ok: true, value: rows[i] }
  }

  return results
}
