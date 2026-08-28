import type { ObjectLinkCursor, ObjectLinkRow } from "./types"

export type ObjectBatchKey = string & {
  readonly __sixbObjectBatchKey: true
}

export type LinkBatchKey = string & {
  readonly __sixbLinkBatchKey: true
}

/** Collision-safe key for object batch-read results. */
export function objectBatchKey(objectTypeId: string, primaryId: string): ObjectBatchKey {
  return JSON.stringify([objectTypeId, primaryId]) as ObjectBatchKey
}

/** Collision-safe key for outgoing-link batch-read results. */
export function linkBatchKey(objectTypeId: string, objectId: string, linkId: string): LinkBatchKey {
  return JSON.stringify([objectTypeId, objectId, linkId]) as LinkBatchKey
}

/** Canonical storage ordering and cursor for physical links. */
export function objectLinkCursor(link: ObjectLinkRow): ObjectLinkCursor {
  return [link.sourceTypeId, link.sourceId, link.linkId, link.targetTypeId, link.targetId]
}

export function compareObjectLinkCursors(left: ObjectLinkCursor, right: ObjectLinkCursor): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

export function compareObjectLinks(left: ObjectLinkRow, right: ObjectLinkRow): number {
  return compareObjectLinkCursors(objectLinkCursor(left), objectLinkCursor(right))
}
