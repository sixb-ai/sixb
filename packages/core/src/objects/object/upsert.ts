/**
 * Leaf operation: upsert a single object.
 */

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

  const appended = await events.append({
    events: [
      {
        type: "object.upserted",
        payload: {
          objectTypeId: objectType.id,
          primaryId,
          properties: normalizedProperties,
        },
      },
    ],
  })

  const event = appended[0]
  if (!event || event.type !== "object.upserted") {
    throw new ObjectError("Failed to append object.upserted event")
  }

  return storage.objects.applyObjectUpserted(event)
}
