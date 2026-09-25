/**
 * Core type definitions for the runtime layer.
 *
 * Hierarchy: SixbHostContext → SixbRuntimeContext → ObjectSet → ObjectByIdHandle
 * Each level narrows generic parameters so downstream code stays type-safe.
 */

import type {
  ActionDefinitionCatalog,
  ActionParamsConfig,
  InferActionParams,
  RequestActionResult,
} from "../actions"
import type { AuthorizationContext } from "../authorization"
import type { Broker } from "../broker"
import type { DomainEventLog } from "../events"
import type { RuntimeAuthorization } from "../execution"
import type { AuthorizedObjectReader } from "../execution/authorized-object-reader"
import type { EmbeddingModelCatalog } from "../models"
import type { ModelExecutionSession } from "../models/execution/session"
import type {
  ObjectQuery,
  ObjectQueryExplanation,
  ObjectQueryPredicateComparison,
  ObjectQueryPredicateContains,
  ObjectQueryPredicateExists,
  ObjectQueryPredicateGroup,
  ObjectQueryPredicateIn,
  ObjectQueryPredicateNot,
  ObjectQuerySortDirection,
  ValidatedObjectQuery,
} from "../objects/query"
import type { ObjectVectorHandle, VectorProfileName } from "../objects/vectors/types"
import type { ObjectLinkTargetType, ObjectRef, ObjectType, Property } from "../ontology"
import type {
  InferObjectProperties,
  InferPropertyUnit,
  InferPropertyValue,
  InferTelemetryBatchProperties,
  InferTelemetryPropertyIds,
} from "../ontology/inference"
import type { RegisteredObjectType } from "../ontology/registered"
import type { OntologyDocumentInput, OntologyRegistry, OntologySource } from "../ontology/registry"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../ontology/tokens"
import type { Queues } from "../queues"
import type { ActionRunRecord, ObjectLinkRow, Storage } from "../storage"
// ── Shared runtime context ──────────────────────────────────

/**
 * Infrastructure and registries owned by the configured host.
 *
 * This context cannot call protected leaves: those require a {@link SixbRuntimeContext} carrying
 * registered runtime authority.
 */
export interface SixbHostContext {
  readonly embeddingModels?: EmbeddingModelCatalog
  readonly projectId: string
  readonly broker: Broker
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionDefinitionCatalog
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly queues: Queues
}

/** Host dependencies paired with the process-local authority of one bound execution. */
export interface SixbRuntimeContext extends SixbHostContext {
  /** Internal model-call session shared by object operations and model generation. */
  readonly modelExecution?: ModelExecutionSession
  readonly runtimeAuthorization: RuntimeAuthorization
  /** Core-owned read boundary carrying this exact execution authority. */
  readonly objectReader: AuthorizedObjectReader
  /**
   * Resolved principal grants. Absent for trusted primitive and explicitly disabled executions.
   * The opaque `runtimeAuthorization` remains the source of authority.
   */
  readonly authorization?: AuthorizationContext
}

// ── Batch result envelopes ──────────────────────────────────

/**
 * Per-item result for batch operations.
 *
 * Allows batch ops to report successes and failures per item without throwing,
 * so callers (e.g. projection executors) can map failures to per-row issues.
 */
export type BatchItemResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error }

// Re-export for backward compatibility — canonical definitions live in ontology/registry.ts
export type { OntologyDocumentInput, OntologySource }

// A type alias, not an interface: relating two generic-interface
// instantiations makes TypeScript measure the interface's variance by probing
// it with marker types, and `InferObjectProperties<marker>` overflows its
// recursion limits (TS2589) in consumers like `rows.map(...)`. The alias
// relates structurally, which stays within limits.
export type TwinObject<TObjectType extends ObjectType> = {
  primaryId: string
  objectTypeId: TObjectType["id"]
  properties: InferObjectProperties<TObjectType>
  createdAt: Date
  updatedAt: Date
}

type MaterializedObjectRow<TObjectType extends Pick<ObjectType, "id" | "properties">> = {
  primaryId: string
  objectTypeId: TObjectType["id"]
  properties: InferObjectProperties<TObjectType>
  createdAt: Date
  updatedAt: Date
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type { ObjectRef }

/**
 * Resolve link target type id for ObjectRef:
 * - `string[]` → union of elements
 * - `"*"` → any string
 * - `string` → literal
 */
type ResolveTargetTypeId<T> = T extends readonly string[] ? T[number] : T extends "*" ? string : T

/**
 * Link token constrained to the given object type.
 *
 * This powers `byId(...).link(Room.l.hasThermostat, target)` style APIs.
 */
type LinkTokenForObjectType<TObjectType extends ObjectTypeWithPropertyTokens> = LinkToken<
  TObjectType["id"],
  TObjectType["links"][number]["id"],
  TObjectType["links"][number]["targetObjectTypeId"],
  TObjectType["links"][number]
>

type PropertyById<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = Extract<TObjectType["properties"][number], { id: TPropertyId }>

type PropertyWhereValue<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = InferPropertyValue<PropertyById<TObjectType, TPropertyId>>

type PropertyWhereContainsValue<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> =
  NonNullable<PropertyWhereValue<TObjectType, TPropertyId>> extends string
    ? string
    : NonNullable<PropertyWhereValue<TObjectType, TPropertyId>> extends readonly (infer TItem)[]
      ? TItem
      : NonNullable<PropertyWhereValue<TObjectType, TPropertyId>> extends Record<string, unknown>
        ? string
        : never

type PropertyWhereComparisonClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = Omit<ObjectQueryPredicateComparison, "propertyId" | "value"> & {
  propertyId: TPropertyId
  value: PropertyWhereValue<TObjectType, TPropertyId>
}

type PropertyWhereInClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = Omit<ObjectQueryPredicateIn, "propertyId" | "values"> & {
  propertyId: TPropertyId
  values: readonly PropertyWhereValue<TObjectType, TPropertyId>[]
}

type PropertyWhereExistsClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = Omit<ObjectQueryPredicateExists, "propertyId"> & {
  propertyId: TPropertyId
}

type PropertyWhereContainsClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = Omit<ObjectQueryPredicateContains, "propertyId" | "value"> & {
  propertyId: TPropertyId
  value: PropertyWhereContainsValue<TObjectType, TPropertyId>
}

/** Predicate operators exposed on `where` builder properties. */
type PropertyPredicate<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
> = {
  eq(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "eq" }
  neq(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "neq" }
  lt(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "lt" }
  lte(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "lte" }
  gt(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "gt" }
  gte(
    value: PropertyWhereValue<TObjectType, TPropertyId>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId> & { op: "gte" }
  in(
    values: readonly PropertyWhereValue<TObjectType, TPropertyId>[]
  ): PropertyWhereInClause<TObjectType, TPropertyId>
  exists(value?: boolean): PropertyWhereExistsClause<TObjectType, TPropertyId>
  contains(
    value: PropertyWhereContainsValue<TObjectType, TPropertyId>
  ): PropertyWhereContainsClause<TObjectType, TPropertyId>
}

type PropertyWhereClause<TObjectType extends ObjectTypeWithPropertyTokens> =
  HasKnownPropertyIds<TObjectType> extends false
    ?
        | ObjectQueryPredicateComparison
        | ObjectQueryPredicateIn
        | ObjectQueryPredicateExists
        | ObjectQueryPredicateContains
    : {
        [TPropertyId in TObjectType["properties"][number]["id"]]:
          | PropertyWhereComparisonClause<TObjectType, TPropertyId>
          | PropertyWhereInClause<TObjectType, TPropertyId>
          | PropertyWhereExistsClause<TObjectType, TPropertyId>
          | PropertyWhereContainsClause<TObjectType, TPropertyId>
      }[TObjectType["properties"][number]["id"]]

/**
 * Predicate operators for an object type whose properties are not statically
 * known, such as after traversing a link whose target type is unresolved.
 * Mirrors `PropertyPredicate` with IR-level value types, and keeps the type
 * shallow — instantiating the typed predicate map over the broad `Property`
 * union overflows TypeScript's recursion limits.
 */
type UntypedPropertyPredicate = {
  eq(value: unknown): ObjectQueryPredicateComparison & { op: "eq" }
  neq(value: unknown): ObjectQueryPredicateComparison & { op: "neq" }
  lt(value: unknown): ObjectQueryPredicateComparison & { op: "lt" }
  lte(value: unknown): ObjectQueryPredicateComparison & { op: "lte" }
  gt(value: unknown): ObjectQueryPredicateComparison & { op: "gt" }
  gte(value: unknown): ObjectQueryPredicateComparison & { op: "gte" }
  in(values: readonly unknown[]): ObjectQueryPredicateIn
  exists(value?: boolean): ObjectQueryPredicateExists
  contains(value: unknown): ObjectQueryPredicateContains
}

/** True when the object type's property ids are statically known literals. */
type HasKnownPropertyIds<TObjectType extends ObjectTypeWithPropertyTokens> =
  string extends TObjectType["properties"][number]["id"] ? false : true

/** Typed ObjectSet where predicate. Serialized shape matches object query IR predicates. */
export type ObjectWhereClause<TObjectType extends ObjectTypeWithPropertyTokens> =
  | PropertyWhereClause<TObjectType>
  | (Omit<ObjectQueryPredicateGroup, "items"> & {
      items: readonly ObjectWhereClause<TObjectType>[]
    })
  | (Omit<ObjectQueryPredicateNot, "item"> & {
      item: ObjectWhereClause<TObjectType>
    })

/**
 * Builder object passed to object query `where` callbacks.
 *
 * Example: `(r) => r.p.externalId.eq("RM-101")`
 */
export type ObjectWhereBuilder<TObjectType extends ObjectTypeWithPropertyTokens> = {
  p: HasKnownPropertyIds<TObjectType> extends false
    ? Record<string, UntypedPropertyPredicate>
    : {
        [TPropertyId in TObjectType["properties"][number]["id"]]: PropertyPredicate<
          TObjectType,
          TPropertyId
        >
      }
  and(...items: readonly ObjectWhereClause<TObjectType>[]): ObjectWhereClause<TObjectType>
  or(...items: readonly ObjectWhereClause<TObjectType>[]): ObjectWhereClause<TObjectType>
  not(item: ObjectWhereClause<TObjectType>): ObjectWhereClause<TObjectType>
}

export type TelemetryPropertyToken<TObjectType extends ObjectTypeWithPropertyTokens> =
  TObjectType["p"][InferTelemetryPropertyIds<TObjectType>]

type AnyPropertyToken = PropertyToken<string, string, Property>

type ObjectSetPropertyId<TObjectType extends ObjectTypeWithPropertyTokens> =
  TObjectType["properties"][number]["id"]

export type ObjectSetQueryPropertyToken<TObjectType extends ObjectTypeWithPropertyTokens> =
  TObjectType["p"][ObjectSetPropertyId<TObjectType>]

/**
 * Unit requirement is conditional:
 * - if property has a semantic type, unit is required
 * - otherwise unit is disallowed
 */
type TelemetryUnitField<TToken extends AnyPropertyToken> =
  // If a property does not map to a semantic type, units are disallowed.
  InferPropertyUnit<TToken["property"]> extends never
    ? { unit?: never }
    : { unit: InferPropertyUnit<TToken["property"]> }

export type TelemetryAppendInput<TToken extends AnyPropertyToken> = {
  value: InferPropertyValue<TToken["property"]>
  at: Date
} & TelemetryUnitField<TToken>

export interface TelemetryHistoryInput {
  readonly from?: Date
  readonly to?: Date
  readonly limit?: number
  readonly order?: "asc" | "desc"
}

/**
 * One object's telemetry for one property, readable and writable.
 *
 * Named a channel rather than an appender because telemetry is not write-only: `history()` reads the
 * same series back, typed through the same token, instead of sending the caller under the typed
 * surface to `sixb.storage.timeseries`.
 */
// A type alias for the same reason as `TwinObject` above: `history()` puts
// `InferPropertyValue` in an output position, and probing a generic interface's variance there
// overflows TS's recursion limits (TS2589) in consumers as ordinary as `points.map(...)`.
export type TelemetryChannel<TToken extends AnyPropertyToken> = {
  append(input: TelemetryAppendInput<TToken>): Promise<void>
  /**
   * Points for this series, oldest first unless `order: "desc"`.
   *
   * The default matches `storage.timeseries.getHistoryBatch`, deliberately: a typed read that ordered
   * differently from the contract underneath it would be its own trap.
   *
   * The point shape is written inline rather than extracted into a named alias. One more level of
   * alias indirection around `InferPropertyValue` in this output position overflows TS's instantiation
   * depth (TS2589) in consumers as ordinary as `points.map(...)` — the same budget the note on
   * `TwinObject` describes. `unit` is inferred through the same token as `append` writes it, rather
   * than widened to `string`: a read that kept `value` precise and gave up on `unit` would be an
   * arbitrary line, and both are the current ontology's view of a series it validated on write.
   */
  history(input?: TelemetryHistoryInput): Promise<
    readonly {
      readonly value: InferPropertyValue<TToken["property"]>
      readonly at: Date
      readonly unit?: InferPropertyUnit<TToken["property"]>
    }[]
  >
}

type TypedActionReference<TParams extends ActionParamsConfig = ActionParamsConfig> = {
  readonly id: string
  readonly params: TParams
}

type TypedActionParams<TAction extends TypedActionReference> =
  TAction extends TypedActionReference<infer TParams> ? InferActionParams<TParams> : never

export type ListResult<T> = {
  objects: T[]
  hasMore: boolean
  nextPageToken?: string
  total: number
}

export type ListResultWithoutTotal<T> = {
  objects: T[]
  hasMore: boolean
  nextPageToken?: string
  total?: undefined
}

export type ObjectQueryListOptions = {
  signal?: AbortSignal
  includeTotal?: boolean
}

export type ObjectQueryFacetInput<TObjectType extends ObjectTypeWithPropertyTokens> = {
  property: ObjectSetQueryPropertyToken<TObjectType>
  limit: number
}

export type ObjectQueryFacetBucket = {
  value: unknown
  count: number
}

export type ObjectQueryFacetResult = {
  propertyId: string
  buckets: ObjectQueryFacetBucket[]
}

export type ObjectSetListInput = {
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

type LinkTargetObjectTypeIdValue = string | readonly string[]

type LinkTargetObjectTypeId<TLinkToken> =
  TLinkToken extends LinkToken<string, string, infer TTargetObjectTypeId>
    ? TTargetObjectTypeId extends readonly (infer TTargetId extends string)[]
      ? TTargetId
      : TTargetObjectTypeId extends string
        ? TTargetObjectTypeId
        : never
    : never

type ObjectTypeForRegisteredId<TObjectTypeId extends string> = [
  Extract<RegisteredObjectType, { id: TObjectTypeId }>,
] extends [never]
  ? ObjectTypeWithPropertyTokens
  : Extract<RegisteredObjectType, { id: TObjectTypeId }>

/**
 * Resolve an object type named by id, as seen from `TSource`.
 *
 * A self-reference (`link.self(...)`, or traversing one backwards) names the source's own id, so it
 * resolves to the source without the generated registry; every other id goes through the registry.
 */
type ObjectTypeForId<TSource extends ObjectTypeWithPropertyTokens, TObjectTypeId extends string> = [
  TObjectTypeId,
] extends [TSource["id"]]
  ? [TSource["id"]] extends [TObjectTypeId]
    ? TSource
    : ObjectTypeForRegisteredId<TObjectTypeId>
  : ObjectTypeForRegisteredId<TObjectTypeId>

type DirectObjectTypeForLink<TLinkToken> =
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue, infer TLink>
    ? Extract<ObjectLinkTargetType<TLink>, ObjectTypeWithPropertyTokens>
    : never

type ObjectTypeForLinkTarget<TSource extends ObjectTypeWithPropertyTokens, TLinkToken> = [
  DirectObjectTypeForLink<TLinkToken>,
] extends [never]
  ? ObjectTypeForId<TSource, LinkTargetObjectTypeId<TLinkToken>>
  : DirectObjectTypeForLink<TLinkToken>

/**
 * True when the target type is a concrete ontology type rather than the degraded
 * generic base. Direct ObjectType links resolve before this point; unresolved
 * id-only refs fall back to the base type, whose property ids are `string`.
 * Instantiating the typed token map over the broad `Property` union there
 * overflows TypeScript (the same reason `UntypedPropertyPredicate` exists). The
 * expand option/sort types degrade to a loose shape in that case so unresolved
 * client paths stay shallow instead of failing.
 */
type HasKnownObjectType<TObjectType extends ObjectTypeWithPropertyTokens> =
  string extends TObjectType["id"] ? false : true

/** Deterministic top-N ordering for a bounded `"many"` expansion, typed against the target type. */
export type ObjectExpansionSort<TObjectType extends ObjectTypeWithPropertyTokens> =
  HasKnownObjectType<TObjectType> extends false
    ? { property: PropertyToken; direction?: ObjectQuerySortDirection }
    : { property: ObjectSetQueryPropertyToken<TObjectType>; direction?: ObjectQuerySortDirection }

/** Options for a single `.expand(...)` of an outgoing link. */
export type ObjectExpandOptions<TObjectType extends ObjectTypeWithPropertyTokens> = {
  /** Bound a `"many"` expansion to the top-N target objects per parent. */
  limit?: number
  /** Order the target objects of a bounded `"many"` expansion. */
  orderBy?: readonly ObjectExpansionSort<TObjectType>[]
}

// ── Expansion shape accumulation (the typed `.links` row) ───────────────────
//
// Each `.expand(link, …)` widens an accumulator type, keyed by link id, with a
// branded {@link ExpansionNode} capturing the resolved target type, cardinality,
// and the nested expansions. The accumulator materializes into the row's `links`
// via {@link ObjectQueryRow}. The discipline that keeps this within TypeScript's
// recursion limits (proven on the real ADN graph): recursion lives ONLY in the
// lazily-evaluated row types below, never in constraints (which are eager); the
// builders are type aliases; targets resolve through direct metadata first and
// the id registry second; and the row is read through a direct conditional
// `infer` (see `BuiltRow`).

/**
 * Cardinality declared on a link token's underlying link; absent cardinality is
 * treated as `"many"`, matching the executor (`link.cardinality ?? "many"`) and
 * the ontology default.
 */
type LinkTokenCardinality<TLinkToken> =
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue, infer TLink>
    ? TLink extends { cardinality: infer TCardinality extends string }
      ? TCardinality
      : "many"
    : "many"

type LinkTokenId<TLinkToken> =
  TLinkToken extends LinkToken<string, infer TLinkId, LinkTargetObjectTypeIdValue> ? TLinkId : never

type LinkTokenSourceObjectTypeId<TLinkToken> =
  TLinkToken extends LinkToken<infer TObjectTypeId, string, LinkTargetObjectTypeIdValue>
    ? TObjectTypeId
    : string

type ObjectLinkCardinality<TLink> = TLink extends { cardinality: infer TCardinality extends string }
  ? TCardinality
  : "many"

type ObjectLinkTarget<TSource extends ObjectTypeWithPropertyTokens, TLink> = [
  Extract<ObjectLinkTargetType<TLink>, ObjectTypeWithPropertyTokens>,
] extends [never]
  ? TLink extends {
      targetObjectTypeId: infer TTargetObjectTypeId extends LinkTargetObjectTypeIdValue
    }
    ? ObjectTypeForId<TSource, ResolveTargetTypeId<TTargetObjectTypeId>>
    : ObjectTypeWithPropertyTokens
  : Extract<ObjectLinkTargetType<TLink>, ObjectTypeWithPropertyTokens>

type ObjectLinkById<
  TObjectType extends Pick<ObjectType, "links">,
  TLinkId extends string,
> = Extract<TObjectType["links"][number], { id: TLinkId }>

type HasKnownObjectLinkIds<TObjectType extends Pick<ObjectType, "links">> =
  string extends TObjectType["links"][number]["id"] ? false : true

/**
 * A branded accumulator entry for one expanded link. Unconstrained on purpose —
 * keeping recursion out of constraints is what avoids TS2589.
 */
type ExpansionNode<TLinkToken, TTarget, TCardinality, TChildren> = {
  readonly __linkToken: TLinkToken
  readonly __target: TTarget
  readonly __cardinality: TCardinality
  readonly __children: TChildren
}

/** The single-key accumulator contribution of one `.expand(link, …)` call from `TSource`. */
type ExpansionEntry<
  TSource extends ObjectTypeWithPropertyTokens,
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue>,
  TChild,
> = {
  [K in TLinkToken["id"]]: ExpansionNode<
    TLinkToken,
    ObjectTypeForLinkTarget<TSource, TLinkToken>,
    LinkTokenCardinality<TLinkToken>,
    TChild
  >
}

type ExpansionNodeForSource<TNode, TObjectType extends ObjectTypeWithPropertyTokens> =
  TNode extends ExpansionNode<infer TLinkToken, infer TTarget, infer TCardinality, infer TChildren>
    ? LinkTokenId<TLinkToken> extends infer TLinkId extends string
      ? HasKnownObjectLinkIds<TObjectType> extends true
        ? [ObjectLinkById<TObjectType, TLinkId>] extends [never]
          ? never
          : ExpansionNode<
              TLinkToken,
              ObjectLinkTarget<TObjectType, ObjectLinkById<TObjectType, TLinkId>>,
              ObjectLinkCardinality<ObjectLinkById<TObjectType, TLinkId>>,
              TChildren
            >
        : LinkTokenSourceObjectTypeId<TLinkToken> extends TObjectType["id"]
          ? ExpansionNode<TLinkToken, TTarget, TCardinality, TChildren>
          : never
      : never
    : never

type ExpansionLinksForSource<TLinks, TObjectType extends ObjectTypeWithPropertyTokens> = {
  [K in keyof TLinks as [ExpansionNodeForSource<TLinks[K], TObjectType>] extends [never]
    ? never
    : K]: ExpansionNodeForSource<TLinks[K], TObjectType>
}

/** Materialize one accumulated expansion entry into its row value. */
type ExpandedLinkType<TNode> =
  TNode extends ExpansionNode<unknown, infer TTarget, infer TCardinality, infer TChildren>
    ? TCardinality extends "one"
      ? ExpandedRowType<TTarget, TChildren> | null
      : ExpandedRowType<TTarget, TChildren>[]
    : never

/**
 * An expanded child row: the target object, optional edge `linkProperties` (the
 * executor attaches it only when the relationship carries metadata), and its own
 * nested `links` (present only when the child was itself expanded). The recursion
 * is confined to this lazily-evaluated position.
 */
/**
 * Loud row substituted for a `.expand()` whose target type is MISSING from an
 * otherwise-present ontology manifest (a stale manifest, or a wrong link target
 * id). Reading a real property is then a compile error pointing at the fix,
 * instead of the old silent `Record<string, unknown>`. The no-manifest loose
 * default stays graceful — this only fires when the registry is concrete yet the
 * target id is absent, i.e. precision was expected but lost.
 */
type UnresolvedExpansionRow = {
  primaryId: string
  objectTypeId: string
  properties: {
    readonly sixb_unresolvedExpansionTarget: "This expansion target is not in the generated ontology manifest. Run `sixb build` / `dev` / `check` to regenerate types, or fix the link's target id."
  }
  createdAt: Date
  updatedAt: Date
}

type ExpandedRowType<TTarget, TChildren> = TTarget extends ObjectTypeWithPropertyTokens
  ? string extends TTarget["id"]
    ? // Target degraded to the loose base. Distinguish the two causes:
      string extends RegisteredObjectType["id"]
      ? // No manifest at all → graceful loose default (unchanged, non-breaking).
        ExpandedRowForSource<
          TTarget,
          ExpansionLinksForSource<TChildren, TTarget>,
          { linkProperties?: Record<string, unknown> }
        >
      : // Manifest present but this target id is absent → loud (was silent).
        UnresolvedExpansionRow
    : ExpandedRowForSource<
        TTarget,
        ExpansionLinksForSource<TChildren, TTarget>,
        { linkProperties?: Record<string, unknown> }
      >
  : never

type ExpandedRowForSource<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TLinks,
  TExtra = unknown,
> = Simplify<
  MaterializedObjectRow<TObjectType> &
    TExtra &
    ([keyof TLinks] extends [never]
      ? unknown
      : { links: { [K in keyof TLinks]: ExpandedLinkType<TLinks[K]> } })
>

/**
 * The terminal row of a query: the matched object, plus a typed `links` map once
 * the query accumulated expansions. A query with no `.expand(...)` returns the
 * plain materialized row, so existing `list`/`first` consumers are unchanged.
 */
export type ObjectQueryRow<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TLinks,
> = TObjectType extends ObjectTypeWithPropertyTokens
  ? ExpandedRowForSource<TObjectType, ExpansionLinksForSource<TLinks, TObjectType>> & {
      score?: number
    }
  : never

/**
 * Builder passed to the nested `.expand(..., (e) => …)` callback. Exposes only
 * `expand`, resolving the next target type from direct metadata or the id
 * registry so deeper hops stay typed and accumulating `TAccumulated` so the
 * nested `.links` shape is recovered from the callback's return.
 *
 * A type alias (not an interface) so relating two instantiations stays
 * structural — the same discipline `TwinObject` follows to avoid TS2589
 * (see the note above `TwinObject`). The only recursion is in the lazily
 * evaluated return/callback positions.
 *
 * When the target type is the degraded base (an unresolved id-only target), the
 * builder collapses to the untyped, non-generic {@link UntypedExpandBuilder}:
 * nested expansion still works, just without target-specific link/property
 * checking, and — crucially — without the self-referential generic instantiation
 * over the broad base type that would otherwise overflow TypeScript.
 */
export type ObjectExpandBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TAccumulated = unknown,
> =
  HasKnownObjectType<TObjectType> extends false
    ? UntypedExpandBuilder
    : {
        // Phantom accumulator — never set at runtime. It is the only direct,
        // covariant site `TAccumulated` appears in, so the nested callback's
        // `TChild` is inferable from the returned builder even after the
        // degradation conditional above resolves (which otherwise buries the
        // accumulator inside `expand`'s return and defeats inference).
        readonly __links?: TAccumulated
        expand<
          TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
          TChild = unknown,
        >(
          link: TLinkToken,
          build: ObjectExpandNested<TObjectType, TLinkToken, TChild>
        ): ObjectExpandBuilder<
          TObjectType,
          TAccumulated & ExpansionEntry<TObjectType, TLinkToken, TChild>
        >
        expand<
          TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
          TChild = unknown,
        >(
          link: TLinkToken,
          options?: ObjectExpandOptions<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
          build?: ObjectExpandNested<TObjectType, TLinkToken, TChild>
        ): ObjectExpandBuilder<
          TObjectType,
          TAccumulated & ExpansionEntry<TObjectType, TLinkToken, TChild>
        >
      }

/**
 * Loose expand builder for degraded targets. Non-generic and self-referential,
 * so it never instantiates the typed token machinery over the broad base type.
 * Nested expansions still run; their shape simply degrades to the loose row.
 */
type UntypedExpandBuilder = {
  expand(
    link: LinkToken,
    optionsOrBuild?:
      | ObjectExpandOptions<ObjectTypeWithPropertyTokens>
      | ((nested: UntypedExpandBuilder) => UntypedExpandBuilder),
    build?: (nested: UntypedExpandBuilder) => UntypedExpandBuilder
  ): UntypedExpandBuilder
}

/**
 * The nested-expansion callback for a link token's resolved target type. `TChild`
 * is inferred from the returned builder's accumulator, recovering the nested
 * `.links` shape; on the degraded path the builder collapses and `TChild` stays
 * its `unknown` default.
 *
 * Kept a plain (non-conditional) function type on purpose: wrapping the callback
 * in a `TLinkToken extends … ? … : never` conditional blocks inference of
 * `TChild` from the argument, so it would silently fall back to `unknown`.
 */
type ObjectExpandNested<
  TSource extends ObjectTypeWithPropertyTokens,
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue>,
  TChild,
> = (
  nested: ObjectExpandBuilder<ObjectTypeForLinkTarget<TSource, TLinkToken>>
) => ObjectExpandBuilder<ObjectTypeForLinkTarget<TSource, TLinkToken>, TChild>

export interface ObjectQueryBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  // Accumulated expansion shape, widened by each `.expand(...)` and materialized
  // into the row's `links` by the `list`/`first` terminals. Empty `{}` until the
  // first expand; `traverse` resets it (the new result type has its own links).
  TLinks = unknown,
> {
  /** Normalized provider-neutral query IR. */
  readonly ir: ObjectQuery

  /** Add a typed property predicate at the current object type. */
  where(
    where: (
      builder: ObjectWhereBuilder<TObjectType>
    ) => ObjectWhereClause<TObjectType> | readonly ObjectWhereClause<TObjectType>[]
  ): ObjectQueryBuilder<TObjectType, TLinks>

  /** Search configured text fields at the current object type. */
  search(
    query: string,
    options?: { fields?: readonly ObjectSetQueryPropertyToken<TObjectType>[] }
  ): ObjectQueryBuilder<TObjectType, TLinks>

  /** Search a profile; text is embedded server-side with its configured model. */
  vector(
    profile: VectorProfileName<TObjectType>,
    vector: string,
    options: { k: number }
  ): ObjectQueryBuilder<TObjectType, TLinks>

  /** Follow an outgoing link and make the linked object type the current result type. */
  traverse<TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>>(
    link: TLinkToken,
    options?: { direction?: "outgoing" }
  ): ObjectQueryBuilder<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>

  /** Follow an incoming link and make the link source object type the current result type. */
  traverse<TLinkToken extends LinkToken<string, string, TObjectType["id"] | readonly string[]>>(
    link: TLinkToken,
    options: { direction: "incoming" }
  ): ObjectQueryBuilder<ObjectTypeForId<TObjectType, TLinkToken["objectTypeId"]>>

  /**
   * Attach an outgoing link's target objects to each row under `.links`, without
   * changing the result type — the additive counterpart to `traverse` (which
   * replaces the set). The callback nests deeper hops.
   *
   * Each call widens `TLinks`, so `list`/`first` rows gain a typed `.links` entry
   * for this link (cardinality `"one"` → `Target | null`, `"many"` → `Target[]`,
   * each carrying optional `linkProperties` and its own nested `.links`). Nested
   * targets stay precise when the link uses direct object targets or when the id
   * target resolves through the registry, and otherwise degrade to the loose base.
   */
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChild = unknown,
  >(
    link: TLinkToken,
    build: ObjectExpandNested<TObjectType, TLinkToken, TChild>
  ): ObjectQueryBuilder<TObjectType, TLinks & ExpansionEntry<TObjectType, TLinkToken, TChild>>
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChild = unknown,
  >(
    link: TLinkToken,
    options?: ObjectExpandOptions<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
    build?: ObjectExpandNested<TObjectType, TLinkToken, TChild>
  ): ObjectQueryBuilder<TObjectType, TLinks & ExpansionEntry<TObjectType, TLinkToken, TChild>>

  /** Add property ordering at the current object type. */
  orderBy(
    property: ObjectSetQueryPropertyToken<TObjectType>,
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TLinks>

  /** Add relevance ordering for providers that support ranked search. */
  orderByRelevance(direction?: ObjectQuerySortDirection): ObjectQueryBuilder<TObjectType, TLinks>

  /** Bound the result count. */
  limit(limit: number): ObjectQueryBuilder<TObjectType, TLinks>

  /** Request one page of results. */
  page(input: { pageSize: number; pageToken?: string }): ObjectQueryBuilder<TObjectType, TLinks>

  /** Validate this query against the registered ontology. */
  validate(): ValidatedObjectQuery

  /** Return a provider-neutral explanation tree for this query. */
  explain(): ObjectQueryExplanation

  /** Format `explain()` as a compact diagnostic string. */
  formatExplanation(): string

  /** Execute this query and return matching objects (rows carry `.links` when expanded). */
  list(): Promise<ListResult<ObjectQueryRow<TObjectType, TLinks>>>
  list(options: {
    includeTotal: false
    signal?: AbortSignal
  }): Promise<ListResultWithoutTotal<ObjectQueryRow<TObjectType, TLinks>>>
  list(options: {
    includeTotal?: true
    signal?: AbortSignal
  }): Promise<ListResult<ObjectQueryRow<TObjectType, TLinks>>>
  list(
    options?: ObjectQueryListOptions
  ): Promise<
    | ListResult<ObjectQueryRow<TObjectType, TLinks>>
    | ListResultWithoutTotal<ObjectQueryRow<TObjectType, TLinks>>
  >

  /** Count the matching objects without returning rows. */
  count(): Promise<number>

  /** Check whether any object matches without returning rows. */
  exists(): Promise<boolean>

  /** Count matching objects by configured facetable properties. */
  facets(input: readonly ObjectQueryFacetInput<TObjectType>[]): Promise<ObjectQueryFacetResult[]>

  /** Execute this query with an outer limit of one and return the first object. */
  first(): Promise<ObjectQueryRow<TObjectType, TLinks> | null>
}

export interface ObjectByIdHandle<TObjectType extends ObjectTypeWithPropertyTokens> {
  vector(profile: VectorProfileName<TObjectType>): ObjectVectorHandle
  /** Get the object at this id, or null if it doesn't exist. */
  get(): Promise<TwinObject<TObjectType> | null>

  /** List links from this object, optionally filtered by link token. */
  listLinks(link?: LinkTokenForObjectType<TObjectType>): Promise<readonly ObjectLinkRow[]>

  /** Create or update a link from the current object to a target object. */
  link<TLinkToken extends LinkTokenForObjectType<TObjectType>>(
    link: TLinkToken,
    target: ObjectRef<ResolveTargetTypeId<TLinkToken["targetObjectTypeId"]>>,
    options?: {
      properties?: Record<string, unknown>
    }
  ): Promise<void>

  /** Remove a link from the current object to a target object. */
  unlink<TLinkToken extends LinkTokenForObjectType<TObjectType>>(
    link: TLinkToken,
    target: ObjectRef<ResolveTargetTypeId<TLinkToken["targetObjectTypeId"]>>
  ): Promise<void>

  /** Request an action on this object by id (dynamic / server contexts). */
  requestAction(input: {
    actionId: string
    params?: Record<string, unknown>
    runId?: string
  }): Promise<RequestActionResult>

  /**
   * Request an action on this object using a typed action reference.
   * Params are inferred from the action's declared shape.
   */
  requestAction<const TAction extends TypedActionReference>(input: {
    action: TAction
    params: NoInfer<TypedActionParams<TAction>>
    runId?: string
  }): Promise<RequestActionResult>

  /** Request an action and wait for the terminal lifecycle event. */
  requestActionAndWait(input: {
    actionId: string
    params?: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ActionRunRecord>

  /** Request a typed action and wait for the terminal lifecycle event. */
  requestActionAndWait<const TAction extends TypedActionReference>(input: {
    action: TAction
    params: NoInfer<TypedActionParams<TAction>>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ActionRunRecord>

  /**
   * Delete this object, cascading over its links in the same commit.
   *
   * For an object written only from code this is not reversible — the identity ceases to exist, and
   * `restore()` has nothing to bring back. For an object a projection also writes, the delete records
   * a managed override: the object stays hidden even while the projection keeps asserting it, until
   * `restore()` withdraws the override.
   *
   * Deleting a missing object is a no-op.
   */
  delete(): Promise<void>

  /** Withdraw a previous `delete()`. A no-op unless a projection still asserts this object. */
  restore(): Promise<void>

  /** Read and write telemetry for one telemetry-mode property token. */
  telemetry<TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryChannel<TToken>
}

export interface ObjectSet<TObjectType extends ObjectTypeWithPropertyTokens> {
  /** Get an object by id, or null if it doesn't exist. */
  get(id: string): Promise<TwinObject<TObjectType> | null>

  /** Upsert object state facts (latest projection). */
  upsert(input: {
    properties: InferObjectProperties<TObjectType>
  }): Promise<TwinObject<TObjectType>>

  /** Build an executable provider-neutral object query rooted at this object type. */
  query(): ObjectQueryBuilder<TObjectType>

  /** Bind operations to a specific object id. */
  byId(id: string): ObjectByIdHandle<TObjectType>

  /** List stored objects of this type with storage-system filtering and pagination. */
  list(input?: ObjectSetListInput): Promise<ListResult<TwinObject<TObjectType>>>

  /** Append telemetry for multiple objects in a single batch. */
  appendTelemetryBatch(
    items: readonly {
      id: string
      properties: InferTelemetryBatchProperties<TObjectType>
      at?: Date
    }[]
  ): Promise<void>

  /** Request an action on an object of this type by id (dynamic / server contexts). */
  requestAction(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
    runId?: string
  }): Promise<RequestActionResult>

  /**
   * Request an action on an object of this type using a typed action reference.
   * Params are inferred from the action's declared shape.
   */
  requestAction<const TAction extends TypedActionReference>(input: {
    id: string
    action: TAction
    params: NoInfer<TypedActionParams<TAction>>
    runId?: string
  }): Promise<RequestActionResult>

  /** Request an action on an object and wait for the terminal lifecycle event. */
  requestActionAndWait(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ActionRunRecord>

  /** Request a typed action and wait for the terminal lifecycle event. */
  requestActionAndWait<const TAction extends TypedActionReference>(input: {
    id: string
    action: TAction
    params: NoInfer<TypedActionParams<TAction>>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ActionRunRecord>

  /** Create or update a link (string-based, for server/dynamic usage). */
  upsertLink(input: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
  }): Promise<void>

  /** Remove a link (string-based, for server/dynamic usage). */
  removeLink(input: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }): Promise<void>
}
