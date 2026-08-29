/**
 * Cross-type object listing for dashboards and search.
 *
 * On principal-bound runtimes the type filter is authorized before the storage call:
 * explicitly requested types must all be viewable, and unfiltered listings
 * narrow to the principal's viewable types instead of post-filtering rows.
 */

import {
  assertAuthorized,
  assertRuntimeAuthorizationBound,
  isRuntimeAllowed,
} from "../../authorization"
import type { ListResult, SixbRuntimeContext } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import { assertObjectListWithinWindow, resolveObjectListWindow } from "./list-window"

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
  const window = resolveObjectListWindow(runtime, params)
  const objectTypeIds = resolveAuthorizedTypeFilter(runtime, params.objectTypeIds)

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
    limit: window.limit,
    offset: window.offset,
    orderBy: params.orderBy,
    order: params.order,
  })
  assertObjectListWithinWindow(window, result.objects.length)

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
  const authority = assertRuntimeAuthorizationBound(runtime)
  if (requested) {
    for (const objectTypeId of requested) {
      runtime.ontology.resolveObjectType(objectTypeId)
    }
  }

  const expanded = requested
    ? [...new Set(requested.flatMap((id) => [id, ...runtime.ontology.listSubTypes(id)]))]
    : undefined

  if (!expanded) {
    if (authority.type === "unrestricted") return undefined

    // Broad listings narrow to the visible universe rather than failing. The
    // current ontology is intersected with principal grants or the immutable delegated snapshot.
    return runtime.ontology
      .listObjectTypes()
      .map((objectType) => objectType.id)
      .filter((objectTypeId) => isRuntimeAllowed(runtime, { kind: "object.view", objectTypeId }))
  }

  if (authority.type === "delegated") {
    // The requested base types must be selected, but newly registered subtypes are simply
    // intersected out. This preserves an issued snapshot without widening it or breaking it when
    // the current ontology later gains another subtype.
    for (const objectTypeId of requested ?? []) {
      assertAuthorized(runtime, { kind: "object.view", objectTypeId })
    }
    return expanded.filter((objectTypeId) =>
      isRuntimeAllowed(runtime, { kind: "object.view", objectTypeId })
    )
  }

  // Explicitly requested types must all be viewable.
  for (const objectTypeId of expanded) {
    assertAuthorized(runtime, { kind: "object.view", objectTypeId })
  }

  return expanded
}
