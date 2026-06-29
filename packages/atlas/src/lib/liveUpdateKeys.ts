import { encodeObjectId } from "@sixb/client"

export type InvalidationKey = readonly unknown[]

export function queryKey(id: string): InvalidationKey {
  return [{ _id: id }] as const
}

export function queryKeyWithPath(id: string, path: Record<string, unknown>): InvalidationKey {
  return [{ _id: id, path }] as const
}

export function queryKeyWithQuery(id: string, query: Record<string, unknown>): InvalidationKey {
  return [{ _id: id, query }] as const
}

export function objectIdKey(objectTypeId: string, primaryId: string): string {
  return encodeObjectId(objectTypeId, primaryId)
}

export function objectCollectionKeys(): InvalidationKey[] {
  return [
    queryKey("listObjects"),
    queryKey("listObjectsPage"),
    queryKey("objectCount"),
    ["atlas", "objects"] as const,
  ]
}

export function objectDetailKey(objectTypeId: string, primaryId: string): InvalidationKey {
  return queryKeyWithPath("getObject", { objectId: objectIdKey(objectTypeId, primaryId) })
}

export function relationshipKey(objectTypeId: string, primaryId: string): InvalidationKey {
  return queryKeyWithQuery("listRelationships", {
    objectId: objectIdKey(objectTypeId, primaryId),
  })
}

export function objectChangedKeys(objectTypeId: string, primaryId: string): InvalidationKey[] {
  return [objectDetailKey(objectTypeId, primaryId), ...objectCollectionKeys()]
}

export function datasetChangedKeys(datasetId: string): InvalidationKey[] {
  return [
    queryKey("listDatasets"),
    queryKeyWithPath("getDataset", { datasetId }),
    queryKeyWithPath("listDatasetVersions", { datasetId }),
    queryKeyWithPath("listDatasetRows", { datasetId }),
  ]
}

export function sameObject(
  left: { readonly objectTypeId: string; readonly primaryId: string },
  right: { readonly objectTypeId: string; readonly primaryId: string }
): boolean {
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}
