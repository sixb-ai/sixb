import { encodeObjectId } from "@sixb/client"
import { objectQueryKeys } from "@sixb/client/hooks"

export type InvalidationKey = readonly unknown[]

export function queryKey(id: string): InvalidationKey {
  return [{ _id: id }] as const
}

export function queryKeyWithPath(id: string, path: Record<string, unknown>): InvalidationKey {
  return [{ _id: id, path }] as const
}

function queryKeyWithQuery(id: string, query: Record<string, unknown>): InvalidationKey {
  return [{ _id: id, query }] as const
}

function objectIdKey(objectTypeId: string, primaryId: string): string {
  return encodeObjectId(objectTypeId, primaryId)
}

// Every object query, the Objects page's and the object page's linked names among them.
function objectCollectionKeys(): InvalidationKey[] {
  return [
    queryKey("listObjects"),
    queryKey("listObjectsPage"),
    queryKey("objectCount"),
    objectQueryKeys.all(),
  ]
}

export function objectDetailKey(objectTypeId: string, primaryId: string): InvalidationKey {
  return queryKeyWithPath("getObject", { objectId: objectIdKey(objectTypeId, primaryId) })
}

/** Where the object's values come from, which every change to the object can move. */
export function objectLineageKey(objectTypeId: string, primaryId: string): InvalidationKey {
  return queryKeyWithPath("getObjectLineage", { objectTypeId, objectId: primaryId })
}

export function relationshipKey(objectTypeId: string, primaryId: string): InvalidationKey {
  return queryKeyWithQuery("listRelationships", {
    objectId: objectIdKey(objectTypeId, primaryId),
  })
}

export function objectChangedKeys(objectTypeId: string, primaryId: string): InvalidationKey[] {
  return [
    objectDetailKey(objectTypeId, primaryId),
    objectLineageKey(objectTypeId, primaryId),
    ...objectCollectionKeys(),
  ]
}

export function workflowChangedKeys(workflowId: string, runId: string): InvalidationKey[] {
  return [
    queryKey("listWorkflows"),
    queryKey("listWorkflowRuns"),
    queryKey("listWorkflowInterventions"),
    queryKey("getWorkflowAgentNodeExecution"),
    queryKeyWithPath("getWorkflow", { workflowId }),
    queryKeyWithPath("getWorkflowRun", { runId }),
  ]
}

export function sameObject(
  left: { readonly objectTypeId: string; readonly primaryId: string },
  right: { readonly objectTypeId: string; readonly primaryId: string }
): boolean {
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}
