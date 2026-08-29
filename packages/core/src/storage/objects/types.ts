import type {
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryPredicate,
  ObjectQuerySetOperation,
  ObjectQuerySortField,
  QueryScalarKind,
} from "../../objects/query"
import type { ObjectReadExecutionLimits } from "./execution-limits"

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

/**
 * Provider-neutral read authority for the latest object projection.
 *
 * `selected` scopes snapshot ontology identifiers, while the concrete object and link instances
 * reachable from their roots are resolved live by the storage provider for every operation.
 */
export type ObjectReadScope = AllObjectReadScope | SelectedObjectReadScope

export interface AllObjectReadScope {
  readonly kind: "all"
}

export interface SelectedObjectReadScope {
  readonly kind: "selected"
  readonly roots: readonly ObjectReadRoot[]
}

export interface ObjectReadRoot {
  readonly anchor: {
    readonly objectTypeId: string
    readonly primaryId: string
  }
  readonly node: ObjectReadNode
}

export interface ObjectReadNode {
  /** Visible properties for every concrete object type snapshotted at this position. */
  readonly objects: readonly ObjectReadObjectSelection[]
  readonly links: readonly ObjectReadLinkSelection[]
}

export interface ObjectReadObjectSelection {
  readonly objectTypeId: string
  readonly propertyIds: readonly string[]
}

export interface ObjectReadLinkSelection {
  /** Physical ontology link definitions allowed from this exact position in the selection tree. */
  readonly definitions: readonly ObjectReadLinkDefinitionSelection[]
  readonly target: ObjectReadNode
}

export interface ObjectReadLinkDefinitionSelection {
  readonly sourceObjectTypeId: string
  readonly linkId: string
  readonly targetObjectTypeIds: readonly string[]
  readonly propertyIds: readonly string[]
}

/** Normalized static scope consumed by storage providers. */
export type CompiledObjectReadScope = AllObjectReadScope | CompiledSelectedObjectReadScope

export interface CompiledSelectedObjectReadScope {
  readonly kind: "selected"
  readonly roots: readonly CompiledObjectReadRoot[]
  readonly objects: readonly CompiledObjectReadObjectSelection[]
  readonly steps: readonly CompiledObjectReadStep[]
}

export interface CompiledObjectReadRoot {
  readonly nodeId: number
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface CompiledObjectReadObjectSelection extends ObjectReadObjectSelection {
  readonly nodeId: number
}

export interface CompiledObjectReadStep {
  /** The target selection node reached by this step. */
  readonly nodeId: number
  readonly parentNodeId: number
  readonly sourceObjectTypeId: string
  readonly linkId: string
  readonly targetObjectTypeId: string
  readonly propertyIds: readonly string[]
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

/** Cross-provider bound for one facet terminal. */
export const MAX_OBJECT_FACETS_PER_READ = 16

/**
 * Provider-facing read-only projection surface consumed by Core.
 *
 * Read scopes returned by {@link ObjectStorage.createReadScope} are bound to one project and must
 * reject calls carrying another project id. This is deliberately not an authorization API:
 * application runtimes read through Core's `AuthorizedObjectReader`.
 */
export interface ObjectReadStorage {
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

  /**
   * Collision-safe batch selection check. Results align exactly with `items`.
   *
   * Providers resolve the live read scope once for the whole batch. Duplicate items are retained
   * so callers can remap results without constructing delimiter-based identity keys. Selection is
   * independent from the property's current materialized value: a selected telemetry property
   * remains selected when the object row does not presently carry that key.
   */
  selectsObjectProperties(params: {
    projectId: string
    items: readonly {
      objectTypeId: string
      primaryId: string
      propertyId: string
    }[]
  }): Promise<readonly boolean[]>

  listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]>

  /**
   * Collision-safe batch object read. Results align exactly with `items`; missing rows are `null`.
   */
  getByPrimaryIdMany(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<readonly (ObjectRow | null)[]>

  /**
   * Collision-safe batch link read. Each result array aligns with the item at the same index.
   */
  listLinksMany(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<readonly (readonly ObjectLinkRow[])[]>

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

/** Latest-state projection storage, including trusted internal read primitives. */
export interface ObjectStorage extends ObjectReadStorage {
  /**
   * Create a live provider scope that constrains every storage operation before row shaping.
   * Core owns authority resolution and is the only layer that should call this method.
   */
  createReadScope(params: {
    projectId: string
    scope: ObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage

  /**
   * Legacy object batch keyed by "objectTypeId:primaryId". Missing items are absent.
   * Colon-delimited keys are retained for compatibility and are not collision-safe. Prefer
   * {@link ObjectReadStorage.getByPrimaryIdMany} in new read paths.
   */
  getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>>

  /**
   * Legacy link batch keyed by "objectTypeId:objectId:linkId". Missing items are absent.
   * Colon-delimited keys are retained for compatibility and are not collision-safe. Prefer
   * {@link ObjectReadStorage.listLinksMany} in new read paths.
   */
  listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>>

  /**
   * Batch fetch every link incident to any of the given objects, in BOTH directions. This trusted
   * primitive is reserved for mutation planning and deliberately absent from
   * {@link ObjectReadStorage}.
   */
  listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]>

  /** Stable keyset page used only by background reconciliation. */
  listByPrimaryIdPage(params: {
    projectId: string
    objectTypeId: string
    afterPrimaryId?: string
    limit: number
  }): Promise<{ objects: readonly ObjectRow[]; nextPrimaryId?: string }>
}
