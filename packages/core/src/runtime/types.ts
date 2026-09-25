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
import type { ObjectLinkTargetType, ObjectRef, Property } from "../ontology"
import type {
  InferPropertyUnit,
  InferPropertyValue,
  InferTelemetryBatchProperties,
  InferTelemetryPropertyIds,
} from "../ontology/inference"
import type { RegisteredObjectType } from "../ontology/registered"
import type { OntologyDocumentInput, OntologyRegistry, OntologySource } from "../ontology/registry"
import type {
  LinkToken,
  ObjectTypeProperties,
  ObjectTypeWithPropertyTokens,
  PropertyToken,
} from "../ontology/tokens"
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

// ── Rows ────────────────────────────────────────────────────
//
// Rows read `properties` from the type inferred where the object type is defined
// (`ObjectTypeProperties`), never from the schema, so relating two rows — or anything returning
// them — costs no schema inference. Rows and query builders also declare their variance, so
// TypeScript never measures it: a measurement that overflows (TS2589) caches the variance it gave
// up on, under which a plain query once passed for an expanded one.

/** One stored object. Covariant: a row of an object type is a row of the loose base type. */
export type TwinObject<out TObjectType extends ObjectTypeWithPropertyTokens> = {
  primaryId: string
  objectTypeId: TObjectType["id"]
  properties: ObjectTypeProperties<TObjectType>
  createdAt: Date
  updatedAt: Date
}

/** A row returned by an object query, before any `.expand(...)`. */
export type ObjectQueryRow<TObjectType extends ObjectTypeWithPropertyTokens> =
  TwinObject<TObjectType> & {
    /** Relevance, present when the query ranks its results (`search`, `vector`). */
    score?: number
  }

/**
 * An object attached under a row's `.links` by `.expand(...)`, before any nested expansion. The
 * executor attaches `linkProperties` only when the relationship carries metadata.
 */
export type ObjectExpansionRow<TObjectType extends ObjectTypeWithPropertyTokens> =
  TwinObject<TObjectType> & {
    linkProperties?: Record<string, unknown>
  }

/**
 * Flattens a row built from intersections, so editors show its fields instead of the aliases it was
 * built from. The `& {}` is what makes TypeScript print the fields.
 */
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
// A type alias, not an interface: `history()` puts `InferPropertyValue` in an output position, and
// probing a generic interface's variance there overflows TS's recursion limits (TS2589) in consumers
// as ordinary as `points.map(...)`.
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
   * depth (TS2589) in consumers as ordinary as `points.map(...)`. `unit` is inferred through the
   * same token as `append` writes it, rather than widened to `string`: a read that kept `value`
   * precise and gave up on `unit` would be an arbitrary line, and both are the current ontology's
   * view of a series it validated on write.
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

type ObjectTypeForRegisteredId<
  TObjectTypeId extends string,
  TFallback extends ObjectTypeWithPropertyTokens,
> = [Extract<RegisteredObjectType, { id: TObjectTypeId }>] extends [never]
  ? TFallback
  : Extract<RegisteredObjectType, { id: TObjectTypeId }>

/**
 * Resolve an object type named by id, as seen from `TSource`.
 *
 * A self-reference (`link.self(...)`, or traversing one backwards) names the source's own id, so it
 * resolves to the source. Every other id resolves through the generated registry first: a type
 * reached through a link is then the very type the app imports and passes to `objects(...)`, which
 * matters because builders are invariant in their object type. `TFallback` applies when the
 * registry does not know the id — without a manifest, or for a stale one.
 */
type ObjectTypeForId<
  TSource extends ObjectTypeWithPropertyTokens,
  TObjectTypeId extends string,
  TFallback extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
> = [TObjectTypeId] extends [TSource["id"]]
  ? [TSource["id"]] extends [TObjectTypeId]
    ? TSource
    : ObjectTypeForRegisteredId<TObjectTypeId, TFallback>
  : ObjectTypeForRegisteredId<TObjectTypeId, TFallback>

type DirectObjectTypeForLink<TLinkToken> =
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue, infer TLink>
    ? Extract<ObjectLinkTargetType<TLink>, ObjectTypeWithPropertyTokens>
    : never

/**
 * The object type a link token points to: the registered type, else the target `link(id, Target)`
 * captured, else the loose base type.
 */
type ObjectTypeForLinkTarget<
  TSource extends ObjectTypeWithPropertyTokens,
  TLinkToken,
> = ObjectTypeForId<
  TSource,
  LinkTargetObjectTypeId<TLinkToken>,
  [DirectObjectTypeForLink<TLinkToken>] extends [never]
    ? ObjectTypeWithPropertyTokens
    : DirectObjectTypeForLink<TLinkToken>
>

/**
 * True when the target type is a concrete ontology type rather than the degraded
 * generic base. Registered and direct targets resolve before this point; unresolved
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

// ── Expansion rows (the typed `.links` map) ─────────────────
//
// A builder carries the row its terminals return. Each `.expand(link, …)` intersects that row with
// one `.links` entry, typed from the link's resolved target and cardinality; a nested callback
// returns a builder carrying the child row. The row is covariant, so an expanded query still passes
// where the plain query is expected.

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

/**
 * Loud row substituted for a `.expand()` whose target type is MISSING from an
 * otherwise-present ontology manifest (a stale manifest, or a wrong link target
 * id). Reading a real property is then a compile error pointing at the fix,
 * instead of a silent `Record<string, unknown>`. The no-manifest loose
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
  linkProperties?: Record<string, unknown>
}

/**
 * The row an expanded target contributes before its own nested expansions. A polymorphic target
 * (`link(id, [A, B])`) yields a union of rows, discriminated by `objectTypeId`.
 */
type ExpandedTargetRow<TTarget extends ObjectTypeWithPropertyTokens> =
  TTarget extends ObjectTypeWithPropertyTokens
    ? HasKnownObjectType<TTarget> extends true
      ? ObjectExpansionRow<TTarget>
      : // The target degraded to the loose base. Without a manifest that is the expected loose
        // row; with one, the target is missing from it.
        string extends RegisteredObjectType["id"]
        ? ObjectExpansionRow<TTarget>
        : UnresolvedExpansionRow
    : never

/** The `.links` entry one `.expand(link, …)` adds: `Target | null` for `"one"`, else `Target[]`. */
type ObjectExpansionLinks<TLinkToken, TChildRow> = {
  links: {
    [K in LinkTokenId<TLinkToken>]: LinkTokenCardinality<TLinkToken> extends "one"
      ? Simplify<TChildRow> | null
      : Simplify<TChildRow>[]
  }
}

/**
 * Add the `.links` entry of one expansion to `TRow`. Distributes over a polymorphic row, so a
 * nested expansion declared on one member type (`owner.expand(User.l.region)`) only reaches the
 * rows of that type.
 */
type WithExpansion<
  TRow,
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue>,
  TChildRow,
> = TRow extends { objectTypeId: infer TObjectTypeId }
  ? TLinkToken["objectTypeId"] extends TObjectTypeId
    ? TRow & ObjectExpansionLinks<TLinkToken, TChildRow>
    : TRow
  : TRow

/**
 * The nested-expansion callback for a link token's resolved target type. `TChildRow`
 * is inferred from the returned builder, recovering the nested `.links` shape.
 *
 * Kept a plain (non-conditional) function type on purpose: wrapping the callback
 * in a `TLinkToken extends … ? … : never` conditional blocks inference of
 * `TChildRow` from the argument, so it would silently fall back to its default.
 */
type ObjectExpandNested<
  TSource extends ObjectTypeWithPropertyTokens,
  TLinkToken extends LinkToken<string, string, LinkTargetObjectTypeIdValue>,
  TChildRow,
> = (
  nested: ObjectExpandBuilder<ObjectTypeForLinkTarget<TSource, TLinkToken>>
) => ObjectExpandBuilder<ObjectTypeForLinkTarget<TSource, TLinkToken>, TChildRow>

/**
 * Builder passed to the nested `.expand(..., (e) => …)` callback. Exposes only `expand`; each call
 * adds a `.links` entry to `TRow`, the row this expanded target contributes to its parent.
 */
export interface ObjectExpandBuilder<
  in out TObjectType extends ObjectTypeWithPropertyTokens,
  out TRow = ExpandedTargetRow<TObjectType>,
> {
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChildRow = ExpandedTargetRow<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
  >(
    link: TLinkToken,
    build: ObjectExpandNested<TObjectType, TLinkToken, TChildRow>
  ): ObjectExpandBuilder<TObjectType, WithExpansion<TRow, TLinkToken, TChildRow>>
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChildRow = ExpandedTargetRow<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
  >(
    link: TLinkToken,
    options?: ObjectExpandOptions<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
    build?: ObjectExpandNested<TObjectType, TLinkToken, TChildRow>
  ): ObjectExpandBuilder<TObjectType, WithExpansion<TRow, TLinkToken, TChildRow>>
}

/**
 * Executable object query rooted at `TObjectType`, returning `TRow` rows.
 *
 * Invariant in the object type, whose predicates and tokens it both accepts and produces, and
 * covariant in the row.
 */
export interface ObjectQueryBuilder<
  in out TObjectType extends ObjectTypeWithPropertyTokens,
  out TRow = ObjectQueryRow<TObjectType>,
> {
  /** Normalized provider-neutral query IR. */
  readonly ir: ObjectQuery

  /** Add a typed property predicate at the current object type. */
  where(
    where: (
      builder: ObjectWhereBuilder<TObjectType>
    ) => ObjectWhereClause<TObjectType> | readonly ObjectWhereClause<TObjectType>[]
  ): ObjectQueryBuilder<TObjectType, TRow>

  /** Search configured text fields at the current object type. */
  search(
    query: string,
    options?: { fields?: readonly ObjectSetQueryPropertyToken<TObjectType>[] }
  ): ObjectQueryBuilder<TObjectType, TRow>

  /** Search a profile; text is embedded server-side with its configured model. */
  vector(
    profile: VectorProfileName<TObjectType>,
    vector: string,
    options: { k: number }
  ): ObjectQueryBuilder<TObjectType, TRow>

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
   * Each call adds a typed `.links` entry to the rows `list`/`first` return
   * (cardinality `"one"` → `Target | null`, `"many"` → `Target[]`, each carrying
   * optional `linkProperties` and its own nested `.links`). Targets are precise
   * when they are registered or linked directly, and otherwise degrade to the
   * loose base.
   */
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChildRow = ExpandedTargetRow<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
  >(
    link: TLinkToken,
    build: ObjectExpandNested<TObjectType, TLinkToken, TChildRow>
  ): ObjectQueryBuilder<TObjectType, WithExpansion<TRow, TLinkToken, TChildRow>>
  expand<
    TLinkToken extends LinkToken<TObjectType["id"], string, LinkTargetObjectTypeIdValue>,
    TChildRow = ExpandedTargetRow<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
  >(
    link: TLinkToken,
    options?: ObjectExpandOptions<ObjectTypeForLinkTarget<TObjectType, TLinkToken>>,
    build?: ObjectExpandNested<TObjectType, TLinkToken, TChildRow>
  ): ObjectQueryBuilder<TObjectType, WithExpansion<TRow, TLinkToken, TChildRow>>

  /** Add property ordering at the current object type. */
  orderBy(
    property: ObjectSetQueryPropertyToken<TObjectType>,
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TRow>

  /** Add relevance ordering for providers that support ranked search. */
  orderByRelevance(direction?: ObjectQuerySortDirection): ObjectQueryBuilder<TObjectType, TRow>

  /** Bound the result count. */
  limit(limit: number): ObjectQueryBuilder<TObjectType, TRow>

  /** Request one page of results. */
  page(input: { pageSize: number; pageToken?: string }): ObjectQueryBuilder<TObjectType, TRow>

  /** Validate this query against the registered ontology. */
  validate(): ValidatedObjectQuery

  /** Return a provider-neutral explanation tree for this query. */
  explain(): ObjectQueryExplanation

  /** Format `explain()` as a compact diagnostic string. */
  formatExplanation(): string

  /** Execute this query and return matching objects (rows carry `.links` when expanded). */
  list(): Promise<ListResult<Simplify<TRow>>>
  list(options: {
    includeTotal: false
    signal?: AbortSignal
  }): Promise<ListResultWithoutTotal<Simplify<TRow>>>
  list(options: { includeTotal?: true; signal?: AbortSignal }): Promise<ListResult<Simplify<TRow>>>
  list(
    options?: ObjectQueryListOptions
  ): Promise<ListResult<Simplify<TRow>> | ListResultWithoutTotal<Simplify<TRow>>>

  /** Count the matching objects without returning rows. */
  count(): Promise<number>

  /** Check whether any object matches without returning rows. */
  exists(): Promise<boolean>

  /** Count matching objects by configured facetable properties. */
  facets(input: readonly ObjectQueryFacetInput<TObjectType>[]): Promise<ObjectQueryFacetResult[]>

  /** Execute this query with an outer limit of one and return the first object. */
  first(): Promise<Simplify<TRow> | null>
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
  upsert(input: { properties: ObjectTypeProperties<TObjectType> }): Promise<TwinObject<TObjectType>>

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
