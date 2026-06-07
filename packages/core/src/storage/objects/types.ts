import type {
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "../../events"
import type {
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryPredicate,
  ObjectQuerySetOperation,
  ObjectQuerySortField,
} from "../../objects/query"

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

export type LinkDirection = "outgoing" | "incoming" | "both"

export type ObjectQueryCapabilityMap<T extends string> = Readonly<Partial<Record<T, boolean>>>

/**
 * Provider-declared object query support.
 *
 * Missing nested flags are treated as unsupported. The planner can use this
 * as a pushdown boundary and decide separately whether bounded fallback is
 * allowed for unsupported nodes.
 */
export interface ObjectQueryCapabilities {
  /** True only when `queryObjects` is implemented and should be called. */
  queryObjects: boolean
  /** True only when `countObjects` is implemented and should be called. */
  countObjects?: boolean
  /** True only when `existsObjects` is implemented and should be called. */
  existsObjects?: boolean
  /** True only when `facetObjects` is implemented and should be called. */
  facetObjects?: boolean
  nodes?: ObjectQueryCapabilityMap<ObjectQuery["kind"]>
  predicateOps?: ObjectQueryCapabilityMap<ObjectQueryPredicate["op"]>
  sortKinds?: ObjectQueryCapabilityMap<ObjectQuerySortField["kind"]>
  traversalDirections?: ObjectQueryCapabilityMap<ObjectQueryDirection>
  setOps?: ObjectQueryCapabilityMap<ObjectQuerySetOperation>
  features?: {
    /**
     * True only when the provider can expand `start.includeSubtypes` itself.
     * Storage-only providers usually cannot, because subtype expansion requires
     * the ontology registry and should fall back to the core executor.
     */
    includeSubtypes?: boolean
  }
  limits?: {
    maxLimit?: number
    maxPageSize?: number
    totalCount?: boolean
    stablePageTokens?: boolean
  }
  notes?: readonly string[]
}

export interface QueryObjectsInput {
  projectId: string
  query: ObjectQuery
  includeTotal?: boolean
}

export interface QueryObjectsResult {
  objects: readonly ObjectRow[]
  hasMore: boolean
  total?: number
  nextPageToken?: string
}

export interface CountObjectsInput {
  projectId: string
  query: ObjectQuery
}

export interface CountObjectsResult {
  count: number
}

export interface ExistsObjectsInput {
  projectId: string
  query: ObjectQuery
}

export interface ExistsObjectsResult {
  exists: boolean
}

export interface ObjectFacetRequest {
  propertyId: string
  limit: number
}

export interface ObjectFacetBucket {
  value: unknown
  count: number
}

export interface ObjectFacetResult {
  propertyId: string
  buckets: readonly ObjectFacetBucket[]
}

export interface FacetObjectsInput {
  projectId: string
  query: ObjectQuery
  facets: readonly ObjectFacetRequest[]
}

export interface FacetObjectsResult {
  facets: readonly ObjectFacetResult[]
}

export interface ObjectStorage {
  queryCapabilities(): ObjectQueryCapabilities

  queryObjects?(params: QueryObjectsInput): Promise<QueryObjectsResult>
  countObjects?(params: CountObjectsInput): Promise<CountObjectsResult>
  existsObjects?(params: ExistsObjectsInput): Promise<ExistsObjectsResult>
  facetObjects?(params: FacetObjectsInput): Promise<FacetObjectsResult>

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

  listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
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
   * Batch fetch outgoing links by (objectTypeId, objectId, linkId) tuples.
   * Returns a Map keyed by "objectTypeId:objectId:linkId". Missing entries are absent.
   */
  listLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
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
