/**
 * Leaf operation: batch upsert objects of a single type.
 */
import { assertPrivileged } from "../../authorization"
import { buildObjectUpsertEvent, hasPropertyChanges } from "../../events"
import { validateObjectBatch } from "../../ontology/validation"
import type { BatchItemResult } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import type { ResolvedObjectContext } from "../context"
import { ObjectError } from "../errors"

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

  // Plan mutations and resolve unchanged items before touching the event stream.
  const mutations: {
    index: number
    event: ReturnType<typeof buildObjectUpsertEvent>
  }[] = []

  for (const { index, item } of validation.valid) {
    const existing = existingMap.get(`${objectType.id}:${item.primaryId}`)
    const properties = {
      ...(existing?.properties ?? {}),
      ...item.properties,
    }
    const event = buildObjectUpsertEvent({
      objectTypeId: objectType.id,
      primaryId: item.primaryId,
      operation: existing ? "update" : "create",
      previousProperties: existing?.properties,
      properties,
    })

    if (existing && !hasPropertyChanges(event.payload.propertyChanges)) {
      results[index] = { ok: true, value: existing }
      continue
    }

    mutations.push({ index, event })
  }

  if (mutations.length === 0) return results

  // Append changed events, then project the stored events into object storage.
  const appended = await eventsRuntime.append({ events: mutations.map(({ event }) => event) })
  const objectEvents = appended.filter(
    (event): event is Extract<typeof event, { type: "object.created" | "object.updated" }> =>
      event.type === "object.created" || event.type === "object.updated"
  )
  if (objectEvents.length !== mutations.length) {
    throw new ObjectError("Failed to append object mutation event batch")
  }

  const rows = await storage.objects.applyObjectUpsertBatch(objectEvents)

  for (let i = 0; i < mutations.length; i++) {
    results[mutations[i].index] = { ok: true, value: rows[i] }
  }

  return results
}
