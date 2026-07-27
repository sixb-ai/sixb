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

export type EndpointExistence = ReadonlySet<string>

export function collectEndpointLookups(
  items: readonly LinkEndpointItem[]
): { objectTypeId: string; primaryId: string }[] {
  const lookups: { objectTypeId: string; primaryId: string }[] = []
  const seen = new Set<string>()

  for (const item of items) {
    for (const endpoint of [
      { objectTypeId: item.objectType.id, primaryId: item.sourceId },
      { objectTypeId: item.targetTypeId, primaryId: item.targetId },
    ]) {
      const key = endpointKey(endpoint.objectTypeId, endpoint.primaryId)
      if (seen.has(key)) continue
      seen.add(key)
      lookups.push(endpoint)
    }
  }

  return lookups
}

export async function loadEndpointExistence(
  ctx: Pick<SixbRuntimeContext, "projectId" | "storage">,
  lookups: readonly { objectTypeId: string; primaryId: string }[]
): Promise<EndpointExistence> {
  if (lookups.length === 0) return new Set()
  const rows = await ctx.storage.objects.getByPrimaryIdBatch({
    projectId: ctx.projectId,
    items: lookups,
  })
  return new Set(rows.keys())
}

/** Throws {@link ObjectNotFoundError} for the first endpoint the read did not find. */
export function requireEndpoints(item: LinkEndpointItem, existing: EndpointExistence): void {
  if (!existing.has(endpointKey(item.objectType.id, item.sourceId))) {
    throw new ObjectNotFoundError(item.objectType.id, item.sourceId, "Source object not found")
  }
  if (!existing.has(endpointKey(item.targetTypeId, item.targetId))) {
    throw new ObjectNotFoundError(item.targetTypeId, item.targetId, "Target object not found")
  }
}

function endpointKey(objectTypeId: string, primaryId: string): string {
  return `${objectTypeId}:${primaryId}`
}
