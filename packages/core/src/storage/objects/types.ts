import type {
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "../../events"

/**
 * Latest-state projection storage for objects and links.
 */

export interface ObjectRow {
  projectId: string
  objectTypeId: string
  primaryId: string
  properties: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  version: number
  sourceEventId?: string
}

export interface ObjectLinkRow {
  projectId: string
  sourceTypeId: string
  sourceId: string
  linkId: string
  targetTypeId: string
  targetId: string
  properties?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  sourceEventId?: string
}

export interface ObjectStorage {
  applyObjectUpserted(event: StoredObjectUpsertedEvent): Promise<ObjectRow>
  applyObjectUpsertedBatch(
    events: readonly StoredObjectUpsertedEvent[]
  ): Promise<readonly ObjectRow[]>
  applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void>
  applyTelemetryAppendedBatch(events: readonly StoredTelemetryAppendedEvent[]): Promise<void>
  applyLinkUpserted(event: StoredLinkUpsertedEvent): Promise<void>
  applyLinkUpsertedBatch(events: readonly StoredLinkUpsertedEvent[]): Promise<void>
  applyLinkRemoved(event: StoredLinkRemovedEvent): Promise<void>

  getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null>

  findFirst(params: {
    projectId: string
    objectTypeId: string
    where?: readonly {
      propertyId: string
      op: "eq"
      value: unknown
    }[]
  }): Promise<ObjectRow | null>

  listLinks(params: {
    projectId: string
    sourceTypeId: string
    sourceId: string
    linkId?: string
  }): Promise<readonly ObjectLinkRow[]>

  /**
   * Batch fetch objects by (objectTypeId, primaryId) pairs.
   * Returns a Map keyed by "objectTypeId:primaryId". Missing items are absent.
   */
  getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>>

  /**
   * Batch fetch links by (sourceTypeId, sourceId, linkId) tuples.
   * Returns a Map keyed by "sourceTypeId:sourceId:linkId". Missing entries are absent.
   */
  listLinksBatch(params: {
    projectId: string
    items: readonly { sourceTypeId: string; sourceId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>>

  list(params: {
    projectId: string
    objectTypeId?: string | readonly string[]
    primaryIdPrefix?: string
    primaryIdSuffix?: string
    updatedAfter?: Date
    updatedBefore?: Date
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
    offset?: number
    orderBy?: "createdAt" | "updatedAt" | "primaryId"
    order?: "asc" | "desc"
  }): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }>
}
