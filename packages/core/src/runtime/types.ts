/**
 * Core type definitions for the runtime layer.
 *
 * Hierarchy: Broker + Storage + Queues → Sixb → ObjectSet → ObjectByIdHandle
 * Each level narrows generic parameters so downstream code stays type-safe.
 */

import type {
  ActionDefinition,
  ActionParamsConfig,
  ActionRegistry,
  ActionsRuntime,
  InferActionParams,
  RequestActionResult,
} from "../actions"
import type { AgentsRuntime } from "../agents"
import type { AuthRuntime } from "../auth"
import type { AuthorizationContext } from "../authorization"
import type { BlobStorage } from "../blob-storage"
import type { Broker } from "../broker"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { EventsRuntime } from "../events"
import type { FunctionDefinition } from "../functions/types"
import type { LakeStorage } from "../lake-storage"
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
import type { ObjectRef, ObjectType, Property, ValueType } from "../ontology"
import type {
  InferObjectProperties,
  InferPropertyUnit,
  InferPropertyValue,
  InferTelemetryBatchProperties,
  InferTelemetryPropertyIds,
} from "../ontology/inference"
import type { OntologyDocumentInput, OntologyRegistry, OntologySource } from "../ontology/registry"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../ontology/tokens"
import type { PipelineDefinition } from "../pipelines/types"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import type { SandboxFactory } from "../sandboxes"
import type { ScheduleDefinition } from "../schedules"
import type { SecurityRegistry } from "../security"
import type { ActionRunRecord, ObjectLinkRow, ObjectRow, Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import type { WorkflowsRuntime } from "../workflows"
import type { ScopedSixb } from "./scoped"

// ── Shared runtime context ──────────────────────────────────

/**
 * Shared runtime context holding infrastructure + ontology registry.
 *
 * Built once by `Sixb` at construction time and threaded to `objects/`
 * service and leaf functions.
 *
 * `Sixb` satisfies this structurally — callers can pass `sixb` directly
 * wherever a `SixbRuntimeContext` is expected.
 */
export interface SixbRuntimeContext {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly sandboxes?: SandboxFactory
  readonly rules?: readonly RuleDefinition[]
  /**
   * Principal scope for this context. Absent on privileged runtimes (raw
   * `sixb`, syncs, workers, tests); present on contexts created by
   * `sixb.as(context)`, where data operations enforce default-deny grants.
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

type ObjectTypeFromSource<TSource> = TSource extends {
  objectTypes: infer TObjectTypes extends readonly ObjectTypeWithPropertyTokens[]
}
  ? TObjectTypes[number]
  : TSource extends ObjectTypeWithPropertyTokens
    ? TSource
    : never

type ValueTypeFromSource<TSource> = TSource extends {
  valueTypes: infer TValueTypes extends readonly ValueType[]
}
  ? TValueTypes[number]
  : never

export type RegisteredObjectType<TOntologySources extends readonly OntologySource[]> =
  ObjectTypeFromSource<TOntologySources[number]>

export type RegisteredValueTypes<TOntologySources extends readonly OntologySource[]> =
  readonly ValueTypeFromSource<TOntologySources[number]>[]

// A type alias, not an interface: relating two generic-interface
// instantiations makes TypeScript measure the interface's variance by probing
// it with marker types, and `InferObjectProperties<marker>` overflows its
// recursion limits (TS2589) in consumers like `rows.map(...)`. The alias
// relates structurally, which stays within limits.
export type TwinObject<TObjectType extends ObjectType, TValueTypes extends readonly ValueType[]> = {
  primaryId: string
  objectTypeId: TObjectType["id"]
  properties: InferObjectProperties<TObjectType, TValueTypes>
  createdAt: Date
  updatedAt: Date
}

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
  TValueTypes extends readonly ValueType[],
> = InferPropertyValue<PropertyById<TObjectType, TPropertyId>, TValueTypes>

type PropertyWhereContainsValue<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> =
  NonNullable<PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>> extends string
    ? string
    : NonNullable<
          PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
        > extends readonly (infer TItem)[]
      ? TItem
      : NonNullable<PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>> extends Record<
            string,
            unknown
          >
        ? string
        : never

type PropertyWhereComparisonClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> = Omit<ObjectQueryPredicateComparison, "propertyId" | "value"> & {
  propertyId: TPropertyId
  value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
}

type PropertyWhereInClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> = Omit<ObjectQueryPredicateIn, "propertyId" | "values"> & {
  propertyId: TPropertyId
  values: readonly PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>[]
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
  TValueTypes extends readonly ValueType[],
> = Omit<ObjectQueryPredicateContains, "propertyId" | "value"> & {
  propertyId: TPropertyId
  value: PropertyWhereContainsValue<TObjectType, TPropertyId, TValueTypes>
}

/** Predicate operators exposed on `where` builder properties. */
type PropertyPredicate<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> = {
  eq(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "eq" }
  neq(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "neq" }
  lt(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "lt" }
  lte(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "lte" }
  gt(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "gt" }
  gte(
    value: PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes> & { op: "gte" }
  in(
    values: readonly PropertyWhereValue<TObjectType, TPropertyId, TValueTypes>[]
  ): PropertyWhereInClause<TObjectType, TPropertyId, TValueTypes>
  exists(value?: boolean): PropertyWhereExistsClause<TObjectType, TPropertyId>
  contains(
    value: PropertyWhereContainsValue<TObjectType, TPropertyId, TValueTypes>
  ): PropertyWhereContainsClause<TObjectType, TPropertyId, TValueTypes>
}

type PropertyWhereClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> =
  HasKnownPropertyIds<TObjectType> extends false
    ?
        | ObjectQueryPredicateComparison
        | ObjectQueryPredicateIn
        | ObjectQueryPredicateExists
        | ObjectQueryPredicateContains
    : {
        [TPropertyId in TObjectType["properties"][number]["id"]]:
          | PropertyWhereComparisonClause<TObjectType, TPropertyId, TValueTypes>
          | PropertyWhereInClause<TObjectType, TPropertyId, TValueTypes>
          | PropertyWhereExistsClause<TObjectType, TPropertyId>
          | PropertyWhereContainsClause<TObjectType, TPropertyId, TValueTypes>
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
export type ObjectWhereClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> =
  | PropertyWhereClause<TObjectType, TValueTypes>
  | (Omit<ObjectQueryPredicateGroup, "items"> & {
      items: readonly ObjectWhereClause<TObjectType, TValueTypes>[]
    })
  | (Omit<ObjectQueryPredicateNot, "item"> & {
      item: ObjectWhereClause<TObjectType, TValueTypes>
    })

/**
 * Builder object passed to object query `where` callbacks.
 *
 * Example: `(r) => r.p.externalId.eq("RM-101")`
 */
export type ObjectWhereBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> = {
  p: HasKnownPropertyIds<TObjectType> extends false
    ? Record<string, UntypedPropertyPredicate>
    : {
        [TPropertyId in TObjectType["properties"][number]["id"]]: PropertyPredicate<
          TObjectType,
          TPropertyId,
          TValueTypes
        >
      }
  and(
    ...items: readonly ObjectWhereClause<TObjectType, TValueTypes>[]
  ): ObjectWhereClause<TObjectType, TValueTypes>
  or(
    ...items: readonly ObjectWhereClause<TObjectType, TValueTypes>[]
  ): ObjectWhereClause<TObjectType, TValueTypes>
  not(
    item: ObjectWhereClause<TObjectType, TValueTypes>
  ): ObjectWhereClause<TObjectType, TValueTypes>
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
type TelemetryUnitField<TToken extends AnyPropertyToken, TValueTypes extends readonly ValueType[]> =
  // If a property does not map to a semantic type, units are disallowed.
  InferPropertyUnit<TToken["property"], TValueTypes> extends never
    ? { unit?: never }
    : { unit: InferPropertyUnit<TToken["property"], TValueTypes> }

export type TelemetryAppendInput<
  TToken extends AnyPropertyToken,
  TValueTypes extends readonly ValueType[],
> = {
  value: InferPropertyValue<TToken["property"], TValueTypes>
  at: Date
} & TelemetryUnitField<TToken, TValueTypes>

export interface TelemetryAppender<
  TToken extends AnyPropertyToken,
  TValueTypes extends readonly ValueType[],
> {
  append(input: TelemetryAppendInput<TToken, TValueTypes>): Promise<void>
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

type LinkTargetObjectTypeId<TLinkToken> =
  TLinkToken extends LinkToken<string, string, infer TTargetObjectTypeId>
    ? TTargetObjectTypeId extends readonly (infer TTargetId extends string)[]
      ? TTargetId
      : TTargetObjectTypeId extends string
        ? TTargetObjectTypeId
        : never
    : never

type ObjectTypeForId<
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TObjectTypeId extends string,
> = [Extract<TRegisteredObjectTypes, { id: TObjectTypeId }>] extends [never]
  ? ObjectTypeWithPropertyTokens
  : Extract<TRegisteredObjectTypes, { id: TObjectTypeId }>

/**
 * True when the target type is a concrete ontology type rather than the degraded
 * generic base. When a link's target is not in the registry (the client path
 * until a registry is generated), `ObjectTypeForId` falls back to the base type,
 * whose property ids are `string`; instantiating the typed token map over the
 * broad `Property` union there overflows TypeScript (the same reason
 * `UntypedPropertyPredicate` exists). The expand option/sort types degrade to a
 * loose shape in that case so the client path stays shallow instead of failing.
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
// builders are type aliases; targets resolve by id against the registry; and the
// row is read through a direct conditional `infer` (see `BuiltRow`).

/**
 * Cardinality declared on a link token's underlying link; absent cardinality is
 * treated as `"many"`, matching the executor (`link.cardinality ?? "many"`) and
 * the ontology default.
 */
type LinkTokenCardinality<TLinkToken> =
  TLinkToken extends LinkToken<string, string, string, infer TLink>
    ? TLink extends { cardinality: infer TCardinality extends string }
      ? TCardinality
      : "many"
    : "many"

/**
 * A branded accumulator entry for one expanded link. Unconstrained on purpose —
 * keeping recursion out of constraints is what avoids TS2589.
 */
type ExpansionNode<TTarget, TCardinality, TChildren> = {
  readonly __target: TTarget
  readonly __cardinality: TCardinality
  readonly __children: TChildren
}

/** The single-key accumulator contribution of one `.expand(link, …)` call. */
type ExpansionEntry<
  TLinkToken extends LinkToken<string, string, string>,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TChild,
> = {
  [K in TLinkToken["id"]]: ExpansionNode<
    ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>,
    LinkTokenCardinality<TLinkToken>,
    TChild
  >
}

/** Materialize one accumulated expansion entry into its row value. */
type ExpandedLinkType<TNode, TValueTypes extends readonly ValueType[]> =
  TNode extends ExpansionNode<infer TTarget, infer TCardinality, infer TChildren>
    ? TCardinality extends "one"
      ? ExpandedRowType<TTarget, TChildren, TValueTypes> | null
      : ExpandedRowType<TTarget, TChildren, TValueTypes>[]
    : never

/**
 * An expanded child row: the target object, optional edge `linkProperties` (the
 * executor attaches it only when the relationship carries metadata), and its own
 * nested `links` (present only when the child was itself expanded). The recursion
 * is confined to this lazily-evaluated position.
 */
type ExpandedRowType<
  TTarget,
  TChildren,
  TValueTypes extends readonly ValueType[],
> = (TTarget extends ObjectTypeWithPropertyTokens ? TwinObject<TTarget, TValueTypes> : never) & {
  linkProperties?: Record<string, unknown>
} & ([keyof TChildren] extends [never]
    ? unknown
    : { links: { [K in keyof TChildren]: ExpandedLinkType<TChildren[K], TValueTypes> } })

/**
 * The terminal row of a query: the matched object, plus a typed `links` map once
 * the query accumulated expansions. A query with no `.expand(...)` returns the
 * plain `TwinObject`, so existing `list`/`first` consumers are unchanged.
 */
export type ObjectQueryRow<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TLinks,
> = [keyof TLinks] extends [never]
  ? TwinObject<TObjectType, TValueTypes>
  : TwinObject<TObjectType, TValueTypes> & {
      links: { [K in keyof TLinks]: ExpandedLinkType<TLinks[K], TValueTypes> }
    }

/**
 * Builder passed to the nested `.expand(..., (e) => …)` callback. Exposes only
 * `expand`, resolving the next target type by id against the registry so deeper
 * hops stay typed and accumulating `TAccumulated` so the nested `.links` shape is
 * recovered from the callback's return.
 *
 * A type alias (not an interface) so relating two instantiations stays
 * structural — the same discipline `TwinObject` follows to avoid TS2589
 * (see the note above `TwinObject`). The only recursion is in the lazily
 * evaluated return/callback positions.
 *
 * When the target type is the degraded base (an unregistered link target, i.e.
 * the client path until a registry is generated), the builder collapses to the
 * untyped, non-generic {@link UntypedExpandBuilder}: nested expansion still
 * works, just without target-specific link/property checking, and — crucially —
 * without the self-referential generic instantiation over the broad base type
 * that would otherwise overflow TypeScript.
 */
export type ObjectExpandBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
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
        expand<TLinkToken extends LinkToken<TObjectType["id"], string, string>, TChild = unknown>(
          link: TLinkToken,
          build: ObjectExpandNested<TLinkToken, TRegisteredObjectTypes, TChild>
        ): ObjectExpandBuilder<
          TObjectType,
          TRegisteredObjectTypes,
          TAccumulated & ExpansionEntry<TLinkToken, TRegisteredObjectTypes, TChild>
        >
        expand<TLinkToken extends LinkToken<TObjectType["id"], string, string>, TChild = unknown>(
          link: TLinkToken,
          options?: ObjectExpandOptions<
            ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>
          >,
          build?: ObjectExpandNested<TLinkToken, TRegisteredObjectTypes, TChild>
        ): ObjectExpandBuilder<
          TObjectType,
          TRegisteredObjectTypes,
          TAccumulated & ExpansionEntry<TLinkToken, TRegisteredObjectTypes, TChild>
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
  TLinkToken extends LinkToken<string, string, string>,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TChild,
> = (
  nested: ObjectExpandBuilder<
    ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>,
    TRegisteredObjectTypes
  >
) => ObjectExpandBuilder<
  ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>,
  TRegisteredObjectTypes,
  TChild
>

export interface ObjectQueryBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
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
      builder: ObjectWhereBuilder<TObjectType, TValueTypes>
    ) =>
      | ObjectWhereClause<TObjectType, TValueTypes>
      | readonly ObjectWhereClause<TObjectType, TValueTypes>[]
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Search configured text fields at the current object type. */
  search(
    query: string,
    options?: { fields?: readonly ObjectSetQueryPropertyToken<TObjectType>[] }
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Search a vector property at the current object type. */
  vector(
    property: ObjectSetQueryPropertyToken<TObjectType>,
    vector: readonly number[],
    options: { k: number }
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Follow an outgoing link and make the linked object type the current result type. */
  traverse<TLinkToken extends LinkToken<TObjectType["id"], string, string>>(
    link: TLinkToken,
    options?: { direction?: "outgoing" }
  ): ObjectQueryBuilder<
    ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>,
    TRegisteredObjectTypes,
    TValueTypes
  >

  /** Follow an incoming link and make the link source object type the current result type. */
  traverse<TLinkToken extends LinkToken<string, string, TObjectType["id"] | readonly string[]>>(
    link: TLinkToken,
    options: { direction: "incoming" }
  ): ObjectQueryBuilder<
    ObjectTypeForId<TRegisteredObjectTypes, TLinkToken["objectTypeId"]>,
    TRegisteredObjectTypes,
    TValueTypes
  >

  /**
   * Attach an outgoing link's target objects to each row under `.links`, without
   * changing the result type — the additive counterpart to `traverse` (which
   * replaces the set). The callback nests deeper hops.
   *
   * Each call widens `TLinks`, so `list`/`first` rows gain a typed `.links` entry
   * for this link (cardinality `"one"` → `Target | null`, `"many"` → `Target[]`,
   * each carrying optional `linkProperties` and its own nested `.links`). Nested
   * targets stay precise on the server path (full registry) and degrade to the
   * loose base on the client until the generated registry sharpens them.
   */
  expand<TLinkToken extends LinkToken<TObjectType["id"], string, string>, TChild = unknown>(
    link: TLinkToken,
    build: ObjectExpandNested<TLinkToken, TRegisteredObjectTypes, TChild>
  ): ObjectQueryBuilder<
    TObjectType,
    TRegisteredObjectTypes,
    TValueTypes,
    TLinks & ExpansionEntry<TLinkToken, TRegisteredObjectTypes, TChild>
  >
  expand<TLinkToken extends LinkToken<TObjectType["id"], string, string>, TChild = unknown>(
    link: TLinkToken,
    options?: ObjectExpandOptions<
      ObjectTypeForId<TRegisteredObjectTypes, LinkTargetObjectTypeId<TLinkToken>>
    >,
    build?: ObjectExpandNested<TLinkToken, TRegisteredObjectTypes, TChild>
  ): ObjectQueryBuilder<
    TObjectType,
    TRegisteredObjectTypes,
    TValueTypes,
    TLinks & ExpansionEntry<TLinkToken, TRegisteredObjectTypes, TChild>
  >

  /** Add property ordering at the current object type. */
  orderBy(
    property: ObjectSetQueryPropertyToken<TObjectType>,
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Add relevance ordering for providers that support ranked search. */
  orderByRelevance(
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Bound the result count. */
  limit(limit: number): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Request one page of results. */
  page(input: {
    pageSize: number
    pageToken?: string
  }): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes, TLinks>

  /** Validate this query against the registered ontology. */
  validate(): ValidatedObjectQuery

  /** Return a provider-neutral explanation tree for this query. */
  explain(): ObjectQueryExplanation

  /** Format `explain()` as a compact diagnostic string. */
  formatExplanation(): string

  /** Execute this query and return matching objects (rows carry `.links` when expanded). */
  list(): Promise<ListResult<ObjectQueryRow<TObjectType, TValueTypes, TLinks>>>
  list(options: {
    includeTotal: false
  }): Promise<ListResultWithoutTotal<ObjectQueryRow<TObjectType, TValueTypes, TLinks>>>
  list(options: {
    includeTotal?: true
  }): Promise<ListResult<ObjectQueryRow<TObjectType, TValueTypes, TLinks>>>
  list(
    options?: ObjectQueryListOptions
  ): Promise<
    | ListResult<ObjectQueryRow<TObjectType, TValueTypes, TLinks>>
    | ListResultWithoutTotal<ObjectQueryRow<TObjectType, TValueTypes, TLinks>>
  >

  /** Count the matching objects without returning rows. */
  count(): Promise<number>

  /** Check whether any object matches without returning rows. */
  exists(): Promise<boolean>

  /** Count matching objects by configured facetable properties. */
  facets(input: readonly ObjectQueryFacetInput<TObjectType>[]): Promise<ObjectQueryFacetResult[]>

  /** Execute this query with an outer limit of one and return the first object. */
  first(): Promise<ObjectQueryRow<TObjectType, TValueTypes, TLinks> | null>
}

export interface ObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  /** Get the object at this id, or null if it doesn't exist. */
  get(): Promise<TwinObject<TObjectType, TValueTypes> | null>

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

  /** Append telemetry to a telemetry-mode property token. */
  telemetry<TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryAppender<TToken, TValueTypes>
}

/**
 * Public API surface of a Sixb runtime instance.
 *
 * The class `Sixb<T>` implements this interface so the contract is
 * enforced at compile time and easy to scan in one place.
 */
export interface SixbInstance<_ extends readonly OntologySource[]> {
  readonly id: string
  readonly ontology: OntologyRegistry
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly sandboxes?: SandboxFactory
  readonly rules?: readonly RuleDefinition[]
  readonly security: SecurityRegistry
  readonly auth: AuthRuntime
  readonly actions: ActionsRuntime
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime

  /** Create a principal-scoped runtime surface that enforces authorization grants. */
  as(context: AuthorizationContext): ScopedSixb<_>

  /** All registered object types. */
  listObjectTypes(): readonly ObjectTypeWithPropertyTokens[]

  /** Lookup an object type by id. */
  getObjectTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null

  /** Resolve an object type by id, or throw if it is unknown. */
  resolveObjectType(objectTypeId: string): ObjectTypeWithPropertyTokens

  /** Value types registered in the runtime ontology, keyed by id. */
  getValueTypesById(): ReadonlyMap<string, ValueType>

  /** All registered function definitions. */
  getFunctionDefinitions(): readonly FunctionDefinition[]

  /** All registered action definitions. */
  getActionDefinitions(): readonly ActionDefinition[]

  /** Lookup an action definition by id. */
  getActionById(actionId: string): ActionDefinition | null

  /** All registered global actions. */
  getGlobalActions(): readonly ActionDefinition[]

  /** All actions valid for an object type, including inherited actions. */
  getActionsForType(objectType: ObjectType): readonly ActionDefinition[]

  /** All registered dataset definitions. */
  getDatasetDefinitions(): readonly DatasetDefinition[]

  /** Lookup a dataset definition by id. */
  getDatasetById(datasetId: string): DatasetDefinition | null

  /** All registered sync definitions. */
  getSyncDefinitions(): readonly SyncDefinition[]

  /** Lookup a sync definition by id. */
  getSyncById(syncId: string): SyncDefinition | null

  /** All registered pipeline definitions. */
  getPipelineDefinitions(): readonly PipelineDefinition[]

  /** Lookup a pipeline definition by id. */
  getPipelineById(pipelineId: string): PipelineDefinition | null

  /** All registered schedule definitions. */
  getScheduleDefinitions(): readonly ScheduleDefinition[]

  /** Lookup a schedule definition by id. */
  getScheduleById(scheduleId: string): ScheduleDefinition | null

  /** All registered rule definitions. */
  getRuleDefinitions(): readonly RuleDefinition[]

  /** Lookup a rule definition by id. */
  getRuleById(ruleId: string): RuleDefinition | null

  /** All registered connector definitions. */
  listConnectors(): readonly ConnectorDefinition[]

  /** Lookup a connector definition by id. */
  getConnectorById(connectorId: string): ConnectorDefinition | null

  /** All webhook endpoints registered through connector adapters. */
  listWebhooks(): readonly RegisteredWebhook[]

  /** Lookup a registered connector webhook by connector id and webhook id. */
  getWebhookById(connectorId: string, webhookId: string): RegisteredWebhook | null

  /**
   * Resolve a connector definition to its connected client.
   *
   * The first call connects lazily and caches the result for reuse within the runtime.
   */
  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>

  /** Start all registered function runtimes. */
  startFunctions(): Promise<void>

  /** Stop all running function runtimes. */
  stopFunctions(): Promise<void>

  /** Start the scheduler runtime for all registered schedules. */
  startScheduler(): Promise<void>

  /** Stop the scheduler runtime. */
  stopScheduler(): Promise<void>

  /** Disconnect all currently connected connector clients. */
  disconnectConnectors(): Promise<void>

  /** Close the runtime broker provider if it owns external resources. */
  closeBroker(): Promise<void>

  /**
   * Type-safe ObjectSet for a registered object type.
   *
   * Not part of this interface because `ObjectSet` triggers deep type
   * instantiation when the generic parameter is the widened base
   * `ObjectTypeWithPropertyTokens`. Use `sixb.objects(MyConcreteType)`
   * directly — TypeScript infers the narrow type from the literal.
   *
   * Signature: `objects<T>(objectType: T): ObjectSet<T, RegisteredValueTypes>`
   */

  /** Get the primary property id for a given object type. */
  getPrimaryPropertyId(objectTypeId: string): string

  /** Upsert an object by type id (for server / dynamic contexts). */
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>

  /** Append telemetry for multiple objects of a given type. */
  appendTelemetry(
    objectTypeId: string,
    items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
  ): Promise<void>

  /** Create or update a link from source to target. */
  upsertLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
  ): Promise<void>

  /** Remove a link from source to target. */
  removeLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string }
  ): Promise<void>

  /** Batch upsert objects of a single type. Returns per-item results. */
  upsertObjectBatch(
    objectTypeId: string,
    items: readonly { properties: Record<string, unknown> }[]
  ): Promise<readonly BatchItemResult<ObjectRow>[]>

  /** Batch upsert links. Returns per-item results. */
  upsertLinkBatch(
    items: readonly {
      objectTypeId: string
      sourceId: string
      linkId: string
      target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
    }[]
  ): Promise<readonly BatchItemResult<void>[]>

  /** Cross-type object listing for dashboards and search. */
  list(params: {
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
  }): Promise<ListResult<ObjectRow>>

  /** Collect all transitive sub-types of the given object type id. */
  getSubTypes(objectTypeId: string): string[]

  /** All registered object projection definitions. */
  getObjectProjections(): readonly ObjectProjectionDefinition[]

  /** All registered link projection definitions. */
  getLinkProjections(): readonly LinkProjectionDefinition[]

  /** All registered telemetry projection definitions. */
  getTelemetryProjections(): readonly TelemetryProjectionDefinition[]

  /** Lookup a registered projection by id. */
  getProjectionById(projectionId: string): ProjectionDefinition | null
}

export interface ObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens = TObjectType,
> {
  /** Get an object by id, or null if it doesn't exist. */
  get(id: string): Promise<TwinObject<TObjectType, TValueTypes> | null>

  /** Upsert object state facts (latest projection). */
  upsert(input: {
    properties: InferObjectProperties<TObjectType, TValueTypes>
  }): Promise<TwinObject<TObjectType, TValueTypes>>

  /** Build an executable provider-neutral object query rooted at this object type. */
  query(): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>

  /** Bind operations to a specific object id. */
  byId(id: string): ObjectByIdHandle<TObjectType, TValueTypes>

  /** List stored objects of this type with storage-system filtering and pagination. */
  list(input?: ObjectSetListInput): Promise<ListResult<TwinObject<TObjectType, TValueTypes>>>

  /** Append telemetry for multiple objects in a single batch. */
  appendTelemetryBatch(
    items: readonly {
      id: string
      properties: InferTelemetryBatchProperties<TObjectType, TValueTypes>
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
