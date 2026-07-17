/**
 * Leaf operation: upsert a single object.
 */

import { assertPrivileged } from "../../authorization"
import { buildObjectUpsertEvent, hasPropertyChanges } from "../../events"
import {
  assertKnownProperties,
  assertRequiredProperties,
  normalizeObjectProperties,
  validateObjectProperties,
} from "../../ontology/validation"
import type { ObjectRow } from "../../storage"
import type { ResolvedObjectContext } from "../context"
import { ObjectError } from "../errors"

export async function upsertObject(
  ctx: ResolvedObjectContext,
  primaryId: string,
  properties: Record<string, unknown>
): Promise<ObjectRow> {
  assertPrivileged(ctx, "upsertObject")
  const { events, storage, projectId, objectType, ontology } = ctx

  assertKnownProperties(objectType, properties)
  validateObjectProperties(objectType, properties, ontology.getValueTypesById())

  // Normalize to JSON-safe values (e.g. Date -> ISO string) before the value
  // reaches the event store, which only accepts JSON. The typed surface accepts
  // `Date | string`; without this a `Date` would be rejected at append time.
  const normalizedProperties = normalizeObjectProperties(
    objectType.properties,
    properties,
    ontology.getValueTypesById(),
    objectType.id
  )

  const existing = await storage.objects.getByPrimaryId({
    projectId,
    objectTypeId: objectType.id,
    primaryId,
  })

  const mergedProperties = {
    ...(existing?.properties ?? {}),
    ...normalizedProperties,
  }
  assertRequiredProperties(objectType, mergedProperties)

  const mutationEvent = buildObjectUpsertEvent({
    objectTypeId: objectType.id,
    primaryId,
    operation: existing ? "update" : "create",
    previousProperties: existing?.properties,
    properties: mergedProperties,
  })

  if (existing && !hasPropertyChanges(mutationEvent.payload.propertyChanges)) {
    return existing
  }

  const appended = await events.append({ events: [mutationEvent] })

  const [event] = appended
  if (!event || (event.type !== "object.created" && event.type !== "object.updated")) {
    throw new ObjectError("Failed to append object mutation event")
  }

  return storage.objects.applyObjectUpsert(event)
}
