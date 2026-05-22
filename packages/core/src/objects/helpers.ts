/**
 * Cross-cutting helpers used across multiple domain subdirectories.
 */
import type { ObjectRow, Storage } from "../storage"
import { ObjectNotFoundError } from "../storage/errors"

/** Load an object by primary id, throwing ObjectNotFoundError if missing. */
export async function requireObject(
  storage: Storage,
  projectId: string,
  objectTypeId: string,
  primaryId: string,
  context: string
): Promise<ObjectRow> {
  const obj = await storage.objects.getByPrimaryId({ projectId, objectTypeId, primaryId })
  if (!obj) throw new ObjectNotFoundError(objectTypeId, primaryId, context)
  return obj
}
