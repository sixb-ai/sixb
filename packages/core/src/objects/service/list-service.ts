/**
 * Cross-type object listing for dashboards and search.
 *
 * On scoped runtimes the type filter is authorized before the storage call:
 * explicitly requested types must all be viewable, and unfiltered listings
 * narrow to the principal's viewable types instead of post-filtering rows.
 */

import { assertAuthorized } from "../../authorization"
import type { ListResult, SixbRuntimeContext } from "../../runtime/types"
import type { ObjectRow } from "../../storage"

export interface ListObjectsParams {
  objectTypeIds?: readonly string[]
  idPrefix?: string
  idSuffix?: string
  updatedAfter?: Date
  updatedBefore?: Date
  createdAfter?: Date
  createdBefore?: Date
  limit?: number
  offset?: number
  orderBy?: "createdAt" | "updatedAt" | "primaryId"
  order?: "asc" | "desc"
}

export async function listObjects(
  runtime: SixbRuntimeContext,
  params: ListObjectsParams
): Promise<ListResult<ObjectRow>> {
  const objectTypeIds = resolveAuthorizedTypeFilter(runtime, params.objectTypeIds)

  if (runtime.authorization && objectTypeIds !== undefined && objectTypeIds.length === 0) {
    return { objects: [], hasMore: false, total: 0 }
  }

  const result = await runtime.storage.objects.list({
    projectId: runtime.projectId,
    objectTypeId: objectTypeIds?.length === 1 ? objectTypeIds[0] : objectTypeIds,
    primaryIdPrefix: params.idPrefix,
    primaryIdSuffix: params.idSuffix,
    updatedAfter: params.updatedAfter,
    updatedBefore: params.updatedBefore,
    createdAfter: params.createdAfter,
    createdBefore: params.createdBefore,
    limit: params.limit,
    offset: params.offset,
    orderBy: params.orderBy,
    order: params.order,
  })

  return {
    objects: [...result.objects],
    hasMore: result.hasMore,
    total: result.total,
  }
}

function resolveAuthorizedTypeFilter(
  runtime: SixbRuntimeContext,
  requested: readonly string[] | undefined
): readonly string[] | undefined {
  if (requested) {
    for (const objectTypeId of requested) {
      runtime.ontology.resolveObjectType(objectTypeId)
    }
  }

  const expanded = requested
    ? [...new Set(requested.flatMap((id) => [id, ...runtime.ontology.listSubTypes(id)]))]
    : undefined

  if (!runtime.authorization) {
    return expanded
  }

  if (!expanded) {
    // Broad listings narrow to the visible universe rather than failing. The
    // set already contains every registered type when "all" was granted.
    return [...runtime.authorization.grants["view:object"]]
  }

  // Explicitly requested types must all be viewable.
  for (const objectTypeId of expanded) {
    assertAuthorized(runtime, { kind: "object.view", objectTypeId })
  }

  return expanded
}
