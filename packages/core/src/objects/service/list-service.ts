/**
 * Cross-type object listing for dashboards and search.
 *
 * Type hierarchies are expanded before the request reaches the canonical object
 * reader, which owns authorization and provider-scope enforcement.
 */

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
  const objectTypeIds = resolveTypeFilter(runtime, params.objectTypeIds)

  if (objectTypeIds !== undefined && objectTypeIds.length === 0) {
    return { objects: [], hasMore: false, total: 0 }
  }

  const result = await runtime.objectReader.list({
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

function resolveTypeFilter(
  runtime: SixbRuntimeContext,
  requested: readonly string[] | undefined
): readonly string[] | undefined {
  if (requested) {
    for (const objectTypeId of requested) {
      runtime.ontology.resolveObjectType(objectTypeId)
    }
  }

  return requested
    ? [...new Set(requested.flatMap((id) => [id, ...runtime.ontology.listSubTypes(id)]))]
    : undefined
}
