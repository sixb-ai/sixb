/**
 * Shared endpoint existence reads for runtime link batches.
 *
 * The Materializer independently refuses a link whose endpoints are not effective. These reads exist
 * only so batch callers keep receiving the public {@link ObjectNotFoundError} for a missing endpoint
 * instead of a generic per-item validation error.
 *
 * An endpoint whose type the writer views through a condition exists for it only when its reader
 * shows it: a hidden one is not found, as a missing one is.
 */

import type { SixbRuntimeContext } from "../../runtime/types"
import { type ObjectRow, objectBatchKey } from "../../storage"
import { ObjectNotFoundError } from "../../storage/errors"

export interface LinkEndpointItem {
  readonly objectType: { readonly id: string }
  readonly sourceId: string
  readonly targetTypeId: string
  readonly targetId: string
}

export interface EndpointExistence {
  readonly keys: ReadonlySet<string>
  /** The endpoints read through a condition, as the writer saw them: its commit expects them. */
  readonly seen: readonly ObjectRow[]
}

type EndpointContext = Pick<SixbRuntimeContext, "projectId" | "storage" | "objectReader">

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
  ctx: EndpointContext,
  lookups: readonly { objectTypeId: string; primaryId: string }[]
): Promise<EndpointExistence> {
  const conditioned = conditionedEndpoints(ctx, lookups)
  const stored = lookups.filter((lookup) => !conditioned.includes(lookup))

  const [rows, seen] = await Promise.all([
    stored.length === 0
      ? new Map<string, ObjectRow>()
      : ctx.storage.objects.getByPrimaryIdBatch({ projectId: ctx.projectId, items: stored }),
    readSeenEndpoints(ctx, conditioned),
  ])

  return { keys: new Set([...rows.keys(), ...seen.keys()]), seen: [...seen.values()] }
}

/** The endpoints whose type the writer views through a condition. */
export function conditionedEndpoints<T extends { readonly objectTypeId: string }>(
  ctx: Pick<SixbRuntimeContext, "objectReader">,
  lookups: readonly T[]
): T[] {
  return lookups.filter((lookup) => ctx.objectReader.viewsThroughCondition(lookup.objectTypeId))
}

/** The endpoints among `conditioned` the writer's reader shows, keyed like the lookups. */
export async function readSeenEndpoints(
  ctx: Pick<SixbRuntimeContext, "objectReader">,
  conditioned: readonly { objectTypeId: string; primaryId: string }[]
): Promise<ReadonlyMap<string, ObjectRow>> {
  if (conditioned.length === 0) return new Map()
  return ctx.objectReader.getByPrimaryIdBatch({ items: conditioned })
}

/** Throws {@link ObjectNotFoundError} for the first endpoint the read did not find. */
export function requireEndpoints(item: LinkEndpointItem, existing: EndpointExistence): void {
  if (!existing.keys.has(endpointKey(item.objectType.id, item.sourceId))) {
    throw new ObjectNotFoundError(item.objectType.id, item.sourceId, "Source object not found")
  }
  if (!existing.keys.has(endpointKey(item.targetTypeId, item.targetId))) {
    throw new ObjectNotFoundError(item.targetTypeId, item.targetId, "Target object not found")
  }
}

function endpointKey(objectTypeId: string, primaryId: string): string {
  return objectBatchKey(objectTypeId, primaryId)
}
