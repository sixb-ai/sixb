/**
 * Cross-cutting helpers used across multiple domain subdirectories.
 */
import type { ObjectRow, Storage } from "../storage"
import { objectNotFound } from "../storage/errors"

/** Load an object by primary id, failing with `storage.object_not_found` if missing. */
export async function requireObject(
  storage: Storage,
  projectId: string,
  objectTypeId: string,
  primaryId: string,
  context: string
): Promise<ObjectRow> {
  const obj = await storage.objects.getByPrimaryId({ projectId, objectTypeId, primaryId })
  if (!obj) throw objectNotFound(objectTypeId, primaryId, context)
  return obj
}
