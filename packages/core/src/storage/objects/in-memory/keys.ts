import { objectBatchKey } from "../keys"
import type { ObjectLinkRow, ObjectRow } from "../types"

export function objectRowKey(projectId: string, objectTypeId: string): string {
  return JSON.stringify([projectId, objectTypeId])
}

export function objectRowProjectPrefix(projectId: string): string {
  return `[${JSON.stringify(projectId)},`
}

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function sourceLinkBucketKey(
  projectId: string,
  sourceTypeId: string,
  sourceId: string
): string {
  return JSON.stringify([projectId, sourceTypeId, sourceId])
}

export function linkRowKey(linkId: string, targetTypeId: string, targetId: string): string {
  return JSON.stringify([linkId, targetTypeId, targetId])
}

export function fullLinkRowKey(row: ObjectLinkRow): string {
  return JSON.stringify([
    row.sourceTypeId,
    row.sourceId,
    row.linkId,
    row.targetTypeId,
    row.targetId,
  ])
}

export function rowIdentityKey(row: ObjectRow): string {
  return rowIdentityKeyParts(row.objectTypeId, row.primaryId)
}

export function rowIdentityKeyParts(objectTypeId: string, primaryId: string): string {
  return objectBatchKey(objectTypeId, primaryId)
}
