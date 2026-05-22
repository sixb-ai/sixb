/**
 * Leaf operation: upsert a single object.
 */

import {
  assertKnownProperties,
  assertRequiredProperties,
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

  const existing = await storage.objects.getByPrimaryId({
    projectId,
    objectTypeId: objectType.id,
    primaryId,
  })

  const mergedProperties = {
    ...(existing?.properties ?? {}),
    ...properties,
  }
  assertRequiredProperties(objectType, mergedProperties)

  const appended = await events.append({
    events: [
      {
        type: "object.upserted",
        payload: {
          objectTypeId: objectType.id,
          primaryId,
          properties,
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
