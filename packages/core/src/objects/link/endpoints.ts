/**
 * Shared endpoint existence reads for runtime link batches.
 *
 * The Materializer independently refuses a link whose endpoints are not effective. These reads exist
 * only so batch callers keep receiving the public {@link ObjectNotFoundError} for a missing endpoint
 * instead of a generic per-item validation error.
 */

import type { SixbRuntimeContext } from "../../runtime/types"
import { ObjectNotFoundError } from "../../storage/errors"

export interface LinkEndpointItem {
  readonly objectType: { readonly id: string }
  readonly sourceId: string
  readonly targetTypeId: string
  readonly targetId: string
}

export type EndpointExistence = ReadonlyMap<string, ReadonlySet<string>>

export function collectEndpointLookups(
  items: readonly LinkEndpointItem[]
): { objectTypeId: string; primaryId: string }[] {
  const lookups: { objectTypeId: string; primaryId: string }[] = []
  const seen = new Map<string, Set<string>>()

  for (const item of items) {
    for (const endpoint of [
      { objectTypeId: item.objectType.id, primaryId: item.sourceId },
      { objectTypeId: item.targetTypeId, primaryId: item.targetId },
    ]) {
      const primaryIds = seen.get(endpoint.objectTypeId) ?? new Set<string>()
      if (primaryIds.has(endpoint.primaryId)) continue
      primaryIds.add(endpoint.primaryId)
      seen.set(endpoint.objectTypeId, primaryIds)
      lookups.push(endpoint)
    }
  }

  return lookups
}

export async function loadEndpointExistence(
  ctx: Pick<SixbRuntimeContext, "projectId" | "storage">,
  lookups: readonly { objectTypeId: string; primaryId: string }[]
): Promise<EndpointExistence> {
  if (lookups.length === 0) return new Map()
  const rows = await ctx.storage.objects.getByPrimaryIdMany({
    projectId: ctx.projectId,
    items: lookups,
  })
  const existing = new Map<string, Set<string>>()
  for (const [index, lookup] of lookups.entries()) {
    if (!rows[index]) continue
    const primaryIds = existing.get(lookup.objectTypeId) ?? new Set<string>()
    primaryIds.add(lookup.primaryId)
    existing.set(lookup.objectTypeId, primaryIds)
  }
  return existing
}

/** Throws {@link ObjectNotFoundError} for the first endpoint the read did not find. */
export function requireEndpoints(item: LinkEndpointItem, existing: EndpointExistence): void {
  if (!existing.get(item.objectType.id)?.has(item.sourceId)) {
    throw new ObjectNotFoundError(item.objectType.id, item.sourceId, "Source object not found")
  }
  if (!existing.get(item.targetTypeId)?.has(item.targetId)) {
    throw new ObjectNotFoundError(item.targetTypeId, item.targetId, "Target object not found")
  }
}
