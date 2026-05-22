/**
 * Core type definitions for the runtime layer.
 *
 * Hierarchy: Broker + Storage + Queues → Pario → ObjectSet → ObjectByIdHandle
 * Each level narrows generic parameters so downstream code stays type-safe.
 */

import type { ActionDefinition, ActionRegistry, InferActionParams } from "../actions"
import type { ParioAuthRuntime } from "../auth"
import type { BlobStorage } from "../blob-storage"
import type { Broker } from "../broker"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { EventsRuntime } from "../events"
import type { FunctionDefinition } from "../functions/types"
import type { LakeStorage } from "../lake-storage"
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
} from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import type { ScheduleDefinition } from "../schedules"
import type { SecurityRegistry } from "../security"
import type { ObjectLinkRow, ObjectRow, Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import type { WorkflowDefinition } from "../workflows"

// ── Shared runtime context ──────────────────────────────────

/**
 * Shared runtime context holding infrastructure + ontology registry.
 *
 * Built once by `Pario` at construction time and threaded to `objects/`
 * service and leaf functions.
 *
 * `Pario` satisfies this structurally — callers can pass `pario` directly
 * wherever a `ParioRuntimeContext` is expected.
 */
export interface ParioRuntimeContext {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly rules?: readonly RuleDefinition[]
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

export interface TwinObject<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[],
> {
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

/**
 * Minimal query clause shape used by `findFirst`.
 *
 * V1 keeps this intentionally tiny (`eq`) while preserving typed values.
 */
type PropertyWhereClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> = {
  propertyId: TPropertyId
  op: "eq"
  value: InferPropertyValue<PropertyById<TObjectType, TPropertyId>, TValueTypes>
}

/** Predicate operators exposed on `where` builder properties. */
type PropertyPredicate<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TPropertyId extends TObjectType["properties"][number]["id"],
  TValueTypes extends readonly ValueType[],
> = {
  eq(
    value: InferPropertyValue<PropertyById<TObjectType, TPropertyId>, TValueTypes>
  ): PropertyWhereClause<TObjectType, TPropertyId, TValueTypes>
}

/** Union of all valid where-clause shapes for the selected object type. */
export type ObjectWhereClause<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> = {
  [TPropertyId in TObjectType["properties"][number]["id"]]: PropertyWhereClause<
    TObjectType,
    TPropertyId,
    TValueTypes
  >
}[TObjectType["properties"][number]["id"]]

/**
 * Builder object passed to `findFirst({ where })`.
 *
 * Example: `(r) => r.p.externalId.eq("RM-101")`
 */
export type ObjectWhereBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> = {
  p: {
    [TPropertyId in TObjectType["properties"][number]["id"]]: PropertyPredicate<
      TObjectType,
      TPropertyId,
      TValueTypes
    >
  }
}

export type TelemetryPropertyToken<TObjectType extends ObjectTypeWithPropertyTokens> =
  TObjectType["p"][InferTelemetryPropertyIds<TObjectType>]

type AnyPropertyToken = PropertyToken<string, string, Property>

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

export type ListResult<T> = {
  objects: T[]
  hasMore: boolean
  total: number
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
  }): Promise<{ runId: string }>

  /**
   * Request an action on this object using a typed `ActionDefinition` reference.
   * Params are inferred from the action's declared shape.
   */
  requestAction<TAction extends ActionDefinition>(input: {
    action: TAction
    params: InferActionParams<TAction["params"]>
    runId?: string
  }): Promise<{ runId: string }>

  /** Request an action and wait for the terminal lifecycle event. */
  requestActionAndWait(input: {
    actionId: string
    params?: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string }>

  /** Request a typed action and wait for the terminal lifecycle event. */
  requestActionAndWait<TAction extends ActionDefinition>(input: {
    action: TAction
    params: InferActionParams<TAction["params"]>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string }>

  /** Append telemetry to a telemetry-mode property token. */
  telemetry<TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryAppender<TToken, TValueTypes>
}

/**
 * Public API surface of a Pario runtime instance.
 *
 * The class `Pario<T>` implements this interface so the contract is
 * enforced at compile time and easy to scan in one place.
 */
export interface ParioInstance<_ extends readonly OntologySource[]> {
  readonly id: string
  readonly ontology: OntologyRegistry
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly rules?: readonly RuleDefinition[]
  readonly security: SecurityRegistry
  readonly auth: ParioAuthRuntime

  /** All registered object types. */
  listObjectTypes(): readonly ObjectTypeWithPropertyTokens[]

  /** Lookup an object type by id. */
  getObjectTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null

  /** All registered function definitions. */
  getFunctionDefinitions(): readonly FunctionDefinition[]

  /** All registered action definitions. */
  getActionDefinitions(): readonly ActionDefinition[]

  /** Lookup an action definition by id. */
  getActionById(actionId: string): ActionDefinition | null

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

  /** All registered workflow definitions. */
  getWorkflowDefinitions(): readonly WorkflowDefinition[]

  /** Lookup a workflow definition by id. */
  getWorkflowById(workflowId: string): WorkflowDefinition | null

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
   * `ObjectTypeWithPropertyTokens`. Use `pario.objects(MyConcreteType)`
   * directly — TypeScript infers the narrow type from the literal.
   *
   * Signature: `objects<T>(objectType: T): ObjectSet<T, RegisteredValueTypes>`
   */

  /** Get the primary property id for a given object type. */
  getPrimaryPropertyId(objectTypeId: string): string

  /** Upsert an object by type id (for server / dynamic contexts). */
  upsertObject(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>

  /** Request an action on an object by type id and id. */
  requestAction(
    objectTypeId: string,
    id: string,
    actionId: string,
    params?: Record<string, unknown>,
    options?: { runId?: string }
  ): Promise<{ runId: string }>

  /** Request an action on an object by type id and wait for its terminal event. */
  requestActionAndWait(
    objectTypeId: string,
    id: string,
    actionId: string,
    params?: Record<string, unknown>,
    options?: { runId?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ runId: string }>

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

  /** Lookup a registered object or link projection by id. */
  getProjectionById(projectionId: string): ProjectionDefinition | null
}

export interface ObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  /** Get an object by id, or null if it doesn't exist. */
  get(id: string): Promise<TwinObject<TObjectType, TValueTypes> | null>

  /** Upsert object state facts (latest projection). */
  upsert(input: {
    properties: InferObjectProperties<TObjectType, TValueTypes>
  }): Promise<TwinObject<TObjectType, TValueTypes>>

  /** Find the first object matching a typed where clause. */
  findFirst(input?: {
    where?: (
      builder: ObjectWhereBuilder<TObjectType, TValueTypes>
    ) =>
      | ObjectWhereClause<TObjectType, TValueTypes>
      | readonly ObjectWhereClause<TObjectType, TValueTypes>[]
  }): Promise<TwinObject<TObjectType, TValueTypes> | null>

  /** Bind operations to a specific object id. */
  byId(id: string): ObjectByIdHandle<TObjectType, TValueTypes>

  /** List objects of this type with filtering and pagination. */
  list(input?: {
    where?: (
      builder: ObjectWhereBuilder<TObjectType, TValueTypes>
    ) =>
      | ObjectWhereClause<TObjectType, TValueTypes>
      | readonly ObjectWhereClause<TObjectType, TValueTypes>[]
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
  }): Promise<ListResult<TwinObject<TObjectType, TValueTypes>>>

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
  }): Promise<{ runId: string }>

  /**
   * Request an action on an object of this type using a typed `ActionDefinition`
   * reference. Params are inferred from the action's declared shape.
   */
  requestAction<TAction extends ActionDefinition>(input: {
    id: string
    action: TAction
    params: InferActionParams<TAction["params"]>
    runId?: string
  }): Promise<{ runId: string }>

  /** Request an action on an object and wait for the terminal lifecycle event. */
  requestActionAndWait(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string }>

  /** Request a typed action and wait for the terminal lifecycle event. */
  requestActionAndWait<TAction extends ActionDefinition>(input: {
    id: string
    action: TAction
    params: InferActionParams<TAction["params"]>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string }>

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
