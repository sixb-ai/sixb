import { type ObjectBatchKey, objectBatchKey } from "../storage"
import type { AuthorizedObjectReader } from "./authorized-object-reader"

export interface ObjectKey {
  readonly objectTypeId: string
  readonly primaryId: string
}

/**
 * The objects among these that a reader sees now, by {@link objectBatchKey}: read through the
 * reader in one call, so its conditions decide. Each object type must be viewable by the reader.
 */
export async function visibleObjects(
  reader: AuthorizedObjectReader,
  objects: readonly ObjectKey[]
): Promise<ReadonlySet<ObjectBatchKey>> {
  const items = new Map<ObjectBatchKey, ObjectKey>()
  for (const { objectTypeId, primaryId } of objects) {
    items.set(objectBatchKey(objectTypeId, primaryId), { objectTypeId, primaryId })
  }

  if (items.size === 0) return new Set()

  const rows = await reader.getByPrimaryIdBatch({ items: [...items.values()] })
  return new Set(rows.keys())
}
