import type {
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryPredicate,
  ObjectQuerySetOperation,
  ObjectQuerySortField,
  QueryScalarKind,
} from "../../objects/query"
import type { LinkBatchKey, ObjectBatchKey } from "./keys"

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
  /** Commit that produced the current effective row. */
  lastCommitId: string
  /**
   * Linked objects attached by an `expand` query node, keyed by link id.
   *
   * Populated by the core executor during graph-aware reads; storage providers
   * never read or write it. The wire response schema and the client `TwinObject`
   * `.links` typing are layered on top of this runtime shape.
   */
  links?: ObjectRowLinks
}

/** Per-link expansion result keyed by link id (see {@link ObjectQueryExpand}). */
export type ObjectRowLinks = Record<string, ExpandedLinkValue>

/**
 * The value attached under one expanded link.
 *
 * Cardinality drives the shape: a `"one"` link yields a single object (or
 * `null` when the link is absent), a `"many"` link yields an array.
 */
export type ExpandedLinkValue = ExpandedObjectRow | readonly ExpandedObjectRow[] | null

/** A hydrated linked object, plus any properties carried on the link edge itself. */
export interface ExpandedObjectRow extends ObjectRow {
  /** Relationship metadata stored on the link instance, when present. */
  linkProperties?: Record<string, unknown>
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
  /** Commit that produced the current effective row. */
  lastCommitId: string
}

export type LinkDirection = "outgoing" | "incoming" | "both"

/** Stable physical-link order: source type/id, link id, then target type/id. */
export type ObjectLinkCursor = readonly [string, string, string, string, string]

export interface QueryObjectLinksInput {
  projectId: string
  /** Object identities are treated as a set; duplicate refs do not duplicate links. */
  objectRefs: readonly { objectTypeId: string; primaryId: string }[]
  direction: LinkDirection
  linkId?: string
  /** When present, both endpoints must belong to this set. An empty set matches no links. */
  endpointObjectTypeIds?: readonly string[]
  after?: ObjectLinkCursor
  limit: number
}

export interface QueryObjectLinksResult {
  links: readonly ObjectLinkRow[]
  hasMore: boolean
}

export type ObjectQueryCapabilityMap<T extends string> = Readonly<Partial<Record<T, boolean>>>

export type ObjectQueryScalarOperation = "equality" | "ordering"

export type ObjectQueryScalarOperations = Readonly<
  Partial<Record<QueryScalarKind, ObjectQueryCapabilityMap<ObjectQueryScalarOperation>>>
>

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
  /** Scalar operations whose semantics the provider can preserve exactly. */
  scalarOperations?: ObjectQueryScalarOperations
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
   * Returns a Map keyed by {@link objectBatchKey}. Missing items are absent.
   */
  getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<ReadonlyMap<ObjectBatchKey, ObjectRow>>

  /**
   * Batch fetch outgoing links by (objectTypeId, objectId, linkId) tuples.
   * Returns a Map keyed by {@link linkBatchKey}. Missing entries are absent.
   */
  listLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<ReadonlyMap<LinkBatchKey, ObjectLinkRow[]>>

  /**
   * Read one canonical page of physical links incident to an object set.
   * Filtering, endpoint-type scope, cursoring, ordering, and the limit are provider-owned so a
   * bounded response never requires loading every incident link into the runtime.
   */
  queryLinks(params: QueryObjectLinksInput): Promise<QueryObjectLinksResult>

  /**
   * Batch fetch every link incident to any of the given objects, in BOTH directions (the object as
   * link source or target). Returns a flat, de-duplicated list: a physical link incident to two
   * listed objects appears once. This unpaged primitive exists for internal materialization and
   * per-parent expansion work; interactive reads use {@link queryLinks}.
   */
  listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]>

  /** Stable keyset page used by background reconciliation without a total-count scan. */
  listByPrimaryIdPage(params: {
    projectId: string
    objectTypeId: string
    afterPrimaryId?: string
    limit: number
  }): Promise<{ objects: readonly ObjectRow[]; nextPrimaryId?: string }>

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
