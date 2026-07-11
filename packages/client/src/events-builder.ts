/**
 * Fluent event-subscription builder (`@sixb/client/events`).
 *
 * `events.object(Type)` creates an immutable, generic-threaded builder
 * that accumulates an event-filter spec and types the payload from the same
 * `Type.p.*` / `Type.l.*` tokens as `expand()`. Channels (`.telemetry()`,
 * `.created()`, `.updated()`, `.link(...)`) narrow both the event type and the
 * payload; `.byId(key)` scopes to one instance. The single core terminal is
 * `.subscribe(handler) => unsubscribe`, which runs a client-side predicate over
 * the live stream. The builder is browser-safe and React-free — hooks live in
 * `@sixb/client/hooks`.
 */

import type {
  ActionDefinition,
  DatasetDefinition,
  InferObjectProperties,
  InferPropertyValue,
  PipelineDefinition,
  RuleDefinition,
  SyncDefinition,
} from "@sixb/core"
import {
  buildEventSelectorPredicate,
  type DatasetEventSelectorBuilder as CoreDatasetEventSelectorBuilder,
  type EventPropertySelector as CoreEventPropertySelector,
  type LinkEventSelectorBuilder as CoreLinkEventSelectorBuilder,
  type ObjectEventSelectorBuilder as CoreObjectEventSelectorBuilder,
  type PipelineEventSelectorBuilder as CorePipelineEventSelectorBuilder,
  type SyncEventSelectorBuilder as CoreSyncEventSelectorBuilder,
  type DatasetEventToken,
  type EventSelectorSpec,
  eventSelectorSpec,
  type PipelineEventToken,
  type SyncEventToken,
  events as selectEvents,
} from "@sixb/core/events/selectors"
import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "@sixb/core/ontology"
import type { SixbEvent, SixbEventOfTopic, SixbEventOfType, SixbEventTopic } from "./events-model"
import { createEventSocket, type EventSocketState } from "./events-transport"
import type { Client } from "./generated/client"

/**
 * Conjunctive event-filter scope. Event subscriptions are a single flat scope
 * (not a query tree), so the spec is a flat record rather than nested nodes.
 */
export interface EventsFilterSpec extends EventSelectorSpec {}

// ── Payload typing ──────────────────────────────────────────────────────────
// Flat, named conditionals keyed on the channel — never a recursive resolver —
// and `TValueTypes` is always pinned to `readonly []` so property-value
// inference stays shallow enough for TypeScript's recursion limits (no TS2589).

type Override<TBase, TPatch> = Omit<TBase, keyof TPatch> & TPatch

type StoredTelemetryEvent = SixbEventOfType<"telemetry.appended">
type StoredObjectUpsertedEvent = SixbEventOfType<"object.upserted">
type StoredObjectCreatedEvent = SixbEventOfType<"object.created">
type StoredObjectUpdatedEvent = SixbEventOfType<"object.updated">

type DatasetUpdatedEventOf<TDataset extends DatasetDefinition> = Override<
  SixbEventOfType<"dataset.version.committed">,
  {
    payload: Override<
      SixbEventOfType<"dataset.version.committed">["payload"],
      { datasetId: TDataset["id"] }
    >
  }
>

type SyncFinishedEventOf<
  TSync extends SyncDefinition,
  TStatus extends "succeeded" | "failed" | "cancelled",
> = Override<
  SixbEventOfType<"sync.run.finished">,
  {
    payload: Override<
      SixbEventOfType<"sync.run.finished">["payload"],
      { syncId: TSync["id"]; status: TStatus }
    >
  }
>

type PipelineFinishedEventOf<
  TPipeline extends PipelineDefinition,
  TStatus extends "succeeded" | "failed" | "cancelled",
> = Override<
  SixbEventOfType<"pipeline.run.finished">,
  {
    payload: Override<
      SixbEventOfType<"pipeline.run.finished">["payload"],
      { pipelineId: TPipeline["id"]; status: TStatus }
    >
  }
>

/** A telemetry append narrowed to one property's ontology-typed value. */
type TelemetryEventForProperty<TToken extends PropertyToken | undefined> =
  TToken extends PropertyToken<string, string, infer TProperty extends Property>
    ? Override<
        StoredTelemetryEvent,
        {
          payload: Override<
            StoredTelemetryEvent["payload"],
            { value: InferPropertyValue<TProperty, readonly []> }
          >
        }
      >
    : StoredTelemetryEvent

/** An object upsert with ontology-typed `payload.properties`. */
type ObjectUpsertedEventOf<TObjectType extends ObjectTypeWithTokens> = Override<
  StoredObjectUpsertedEvent,
  {
    payload: Override<
      StoredObjectUpsertedEvent["payload"],
      { properties: InferObjectProperties<TObjectType, readonly []> }
    >
  }
>

/** An object created/updated fact with ontology-typed `payload.properties`. */
type ObjectPropertiesEventOf<
  TObjectType extends ObjectTypeWithTokens,
  TEvent extends SixbEvent,
> = Override<
  TEvent,
  {
    payload: Override<
      TEvent["payload"],
      { properties: InferObjectProperties<TObjectType, readonly []> }
    >
  }
>

type ObjectCreatedEventOf<TObjectType extends ObjectTypeWithTokens> = ObjectPropertiesEventOf<
  TObjectType,
  StoredObjectCreatedEvent
>

type ObjectUpdatedEventOf<TObjectType extends ObjectTypeWithTokens> = ObjectPropertiesEventOf<
  TObjectType,
  StoredObjectUpdatedEvent
>

type EventPropertySelectorMap<TTokens, TObjectType extends ObjectTypeWithTokens> = {
  readonly [K in keyof TTokens]: TTokens[K] extends PropertyToken
    ? EventPropertyBuilder<TObjectType>
    : never
}

type LinkPropertyTokens<TLink extends LinkToken> =
  NonNullable<TLink["link"]["properties"]> extends readonly Property[]
    ? {
        readonly [P in NonNullable<TLink["link"]["properties"]>[number] as P["id"]]: PropertyToken<
          TLink["objectTypeId"],
          P["id"],
          P
        >
      }
    : Record<never, never>

/** Default event union for an object-scoped builder before a channel narrows it. */
type ObjectScopedEvent =
  | SixbEventOfTopic<"objects">
  | SixbEventOfTopic<"telemetry">
  | SixbEventOfTopic<"links">

// ── Builder surfaces ──────────────────────────────────────────────────────────

export interface EventSubscribeOptions {
  readonly afterCursor?: string
  readonly limit?: number
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly handshakeTimeoutMs?: number
  readonly onError?: (error: string) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

/** Object-scoped builder: `events.object(Type)`. Channels narrow the event + payload. */
export interface EventsBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TEvent extends SixbEvent = ObjectScopedEvent,
> {
  /** Accumulated event-filter spec. */
  readonly ir: EventsFilterSpec

  /** Object property change selectors. */
  readonly p: EventPropertySelectorMap<TObjectType["p"], TObjectType>

  /** Telemetry appends, optionally narrowed to one property's typed value. */
  telemetry<TToken extends PropertyToken<TObjectType["id"]> | undefined = undefined>(
    property?: TToken
  ): EventsBuilder<TObjectType, TelemetryEventForProperty<TToken>>

  /** @deprecated Use `.created()` or `.updated()` instead. */
  upserted(): EventsBuilder<TObjectType, ObjectUpsertedEventOf<TObjectType>>

  /** Object creation facts. */
  created(): EventsBuilder<TObjectType, ObjectCreatedEventOf<TObjectType>>

  /** Object update facts. */
  updated(): EventsBuilder<TObjectType, ObjectUpdatedEventOf<TObjectType>>

  /** Object deletion facts. */
  deleted(): EventsBuilder<TObjectType, SixbEventOfType<"object.deleted">>

  /** @deprecated Use `.link(token).created()`, `.updated()`, or `.deleted()` instead. */
  linked(link?: LinkToken<TObjectType["id"]>): EventsBuilder<TObjectType, SixbEventOfTopic<"links">>

  /** Outgoing link mutation facts scoped to one link token. */
  link<TLink extends LinkToken<TObjectType["id"]>>(
    link: TLink
  ): EventsLinkBuilder<TObjectType, TLink>

  /** Scope to a single object instance (orthogonal to the channel). */
  byId(primaryId: string): EventsBuilder<TObjectType, TEvent>

  /** Subscribe to matching events; returns an unsubscribe function. */
  subscribe(handler: (event: TEvent) => void, options?: EventSubscribeOptions): () => void
}

export interface EventsLinkBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken<TObjectType["id"]>,
  TEvent extends SixbEvent =
    | SixbEventOfType<"link.created">
    | SixbEventOfType<"link.updated">
    | SixbEventOfType<"link.deleted">,
> extends SubscribableEvents<TEvent> {
  readonly p: EventPropertySelectorMap<LinkPropertyTokens<TLink>, TObjectType>

  created(): EventsLinkBuilder<TObjectType, TLink, SixbEventOfType<"link.created">>
  updated(): EventsLinkBuilder<TObjectType, TLink, SixbEventOfType<"link.updated">>
  deleted(): EventsLinkBuilder<TObjectType, TLink, SixbEventOfType<"link.deleted">>
  /** @deprecated Use `.deleted()` instead. */
  removed(): EventsLinkBuilder<TObjectType, TLink, SixbEventOfType<"link.deleted">>
}

export interface EventPropertyBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TEvent extends SixbEvent =
    | SixbEventOfType<"object.created">
    | SixbEventOfType<"object.updated">
    | SixbEventOfType<"link.created">
    | SixbEventOfType<"link.updated">,
> extends SubscribableEvents<TEvent> {
  created(): EventPropertyBuilder<TObjectType, TEvent>
  updated(): EventPropertyBuilder<TObjectType, TEvent>
  cleared(): EventPropertyBuilder<TObjectType, TEvent>
}

/** Topic-scoped builder: `events.telemetry()`, `events.all()`, … */
export interface EventsTopicBuilder<TEvent extends SixbEvent> extends SubscribableEvents<TEvent> {
  /** Scope to a single object instance (objects / telemetry / links topics). */
  byId(primaryId: string): EventsTopicBuilder<TEvent>
}

/** Run-scoped topic builder: `events.workflows()`, `events.pipelines()`, `events.syncs()`. */
export interface EventsRunBuilder<TEvent extends SixbEvent> extends SubscribableEvents<TEvent> {
  /** Scope to a single run id. */
  run(runId: string): EventsRunBuilder<TEvent>
}

/** Object-subject scope builder for action events: `events.actions().subject(Type).byId(id)`. */
export interface EventsActionSubjectBuilder<TEvent extends SixbEvent>
  extends SubscribableEvents<TEvent> {
  /** Scope to a single action subject object. */
  byId(primaryId: string): EventsActionBuilder<TEvent>
}

/** Action-scoped topic builder: `events.actions().run(runId).completed()`. */
export interface EventsActionBuilder<TEvent extends SixbEvent> extends SubscribableEvents<TEvent> {
  /** Scope to a single action run id. */
  run(runId: string): EventsActionBuilder<TEvent>

  /** Scope to one action definition id. */
  action(actionId: string): EventsActionBuilder<TEvent>

  /** Scope to an object-bound action subject type. */
  subject<TObjectType extends ObjectTypeWithTokens>(
    objectType: TObjectType
  ): EventsActionSubjectBuilder<TEvent>
  subject(objectTypeId: string): EventsActionSubjectBuilder<TEvent>

  /** Action request events. */
  requested(): EventsActionBuilder<SixbEventOfType<"action.requested">>

  /** Successful terminal action events. */
  completed(): EventsActionBuilder<SixbEventOfType<"action.completed">>

  /** Failed or cancelled terminal action events. */
  failed(): EventsActionBuilder<SixbEventOfType<"action.failed">>

  /** All terminal action events. */
  terminal(): EventsActionBuilder<
    SixbEventOfType<"action.completed"> | SixbEventOfType<"action.failed">
  >
}

/** Rule-scoped topic builder: `events.rule(rule).triggered()`. */
export interface EventsRuleBuilder<TEvent extends SixbEvent> extends SubscribableEvents<TEvent> {
  triggered(): EventsRuleBuilder<SixbEventOfType<"rule.triggered">>
  resolved(): EventsRuleBuilder<SixbEventOfType<"rule.resolved">>
}

export interface EventsDatasetBuilder<TDataset extends DatasetDefinition, TEvent extends SixbEvent>
  extends SubscribableEvents<TEvent> {
  updated(): EventsDatasetBuilder<TDataset, DatasetUpdatedEventOf<TDataset>>
}

export interface EventsSyncBuilder<TSync extends SyncDefinition, TEvent extends SixbEvent>
  extends SubscribableEvents<TEvent> {
  succeeded(): EventsSyncBuilder<TSync, SyncFinishedEventOf<TSync, "succeeded">>
  failed(): EventsSyncBuilder<TSync, SyncFinishedEventOf<TSync, "failed">>
  cancelled(): EventsSyncBuilder<TSync, SyncFinishedEventOf<TSync, "cancelled">>
}

export interface EventsPipelineBuilder<
  TPipeline extends PipelineDefinition,
  TEvent extends SixbEvent,
> extends SubscribableEvents<TEvent> {
  succeeded(): EventsPipelineBuilder<TPipeline, PipelineFinishedEventOf<TPipeline, "succeeded">>
  failed(): EventsPipelineBuilder<TPipeline, PipelineFinishedEventOf<TPipeline, "failed">>
  cancelled(): EventsPipelineBuilder<TPipeline, PipelineFinishedEventOf<TPipeline, "cancelled">>
}

/**
 * The minimal builder contract the React hooks consume: a filter spec plus a
 * typed `subscribe`. Every builder surface satisfies it, and the hooks infer
 * the event type `TEvent` from the builder they are handed.
 */
export interface SubscribableEvents<TEvent extends SixbEvent> {
  readonly ir: EventsFilterSpec
  subscribe(handler: (event: TEvent) => void, options?: EventSubscribeOptions): () => void
}

// ── Subscribe executor (the transport seam) ───────────────────────────────────

export interface EventSubscribeExecutor {
  subscribe(
    filter: EventsFilterSpec,
    handler: (event: SixbEvent) => void,
    options?: EventSubscribeOptions
  ): () => void
}

/**
 * WebSocket-backed executor. The transport sends the server-supported scope,
 * then `buildEventPredicate` applies the full filter client-side before the
 * handler runs. That keeps property/link filters local and makes server
 * filtering an optimization rather than a correctness dependency.
 */
export function createWsSubscribeExecutor(options?: { client?: Client }): EventSubscribeExecutor {
  const baseUrl = options?.client?.getConfig().baseUrl
  return {
    subscribe(filter, handler, subscribeOptions) {
      const matches = buildEventPredicate(filter)
      const socket = createEventSocket({
        topic: filter.topic,
        types: filter.types,
        // Object/action/run scope is filtered server-side; the client predicate
        // still refines propertyId/linkId and guards correctness.
        objectTypeId: filter.objectTypeId,
        primaryId: filter.primaryId,
        actionId: filter.actionId,
        runId: filter.runId,
        afterCursor: subscribeOptions?.afterCursor,
        limit: subscribeOptions?.limit,
        reconnect: subscribeOptions?.reconnect,
        reconnectDelayMs: subscribeOptions?.reconnectDelayMs,
        handshakeTimeoutMs: subscribeOptions?.handshakeTimeoutMs,
        baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
        onEvent: (event) => {
          if (matches(event)) handler(event)
        },
        onError: subscribeOptions?.onError,
        onStateChange: subscribeOptions?.onStateChange,
      })
      return () => socket.close()
    },
  }
}

/**
 * Pure predicate that narrows the live stream to the builder's filter spec. Scope keys
 * are resolved by core's `scopeKeysForEvent` — the same extraction the server
 * poll loop uses — so client and server can never drift on what a topic's
 * identity fields are.
 */
export function buildEventPredicate(filter: EventsFilterSpec): (event: SixbEvent) => boolean {
  const matches = buildEventSelectorPredicate(filter)
  return (event) => matches(event)
}

// ── Runtime backing ───────────────────────────────────────────────────────────

type EventsBuilderParams = {
  readonly filter: EventsFilterSpec
  readonly executor: EventSubscribeExecutor
  readonly objectType?: ObjectTypeWithTokens
  readonly linkToken?: LinkToken
  readonly selector?: CoreEventSelector
}

type CoreEventSelector =
  | CoreObjectEventSelectorBuilder<ObjectTypeWithTokens>
  | CoreLinkEventSelectorBuilder<ObjectTypeWithTokens, LinkToken>
  | CoreEventPropertySelector
  | CoreDatasetEventSelectorBuilder<DatasetEventToken>
  | CoreSyncEventSelectorBuilder<SyncEventToken>
  | CorePipelineEventSelectorBuilder<PipelineEventToken>

/**
 * One immutable implementation backs every builder surface. Each method returns
 * a fresh instance (copy-on-write on the filter spec), and the factory functions cast it
 * to the surface that exposes the right methods — mirroring the object query
 * builder's `as unknown as` seam.
 */
class EventsBuilderImpl {
  constructor(private readonly params: EventsBuilderParams) {}

  get ir(): EventsFilterSpec {
    return this.params.filter
  }

  get p(): Record<string, EventPropertyBuilder<ObjectTypeWithTokens>> {
    const selector = this.params.selector
    if (!selector || !("p" in selector)) {
      return {}
    }

    const tokens = this.params.linkToken
      ? createLinkPropertyTokens(this.params.linkToken)
      : (this.params.objectType?.p ?? {})

    return createPropertySelectorMap(tokens, (property) => {
      const propertySelector = selector.p[property.id]
      if (!propertySelector) {
        throw new Error(`[SixbClient] Unknown event selector property '${property.id}'.`)
      }
      return this.withSelector(propertySelector)
    })
  }

  telemetry(property?: PropertyToken): EventsBuilderImpl {
    return this.withFilter({
      topic: "telemetry",
      types: ["telemetry.appended"],
      ...(property ? { propertyId: property.id } : {}),
    })
  }

  upserted(): EventsBuilderImpl {
    return this.withFilter({ topic: "objects", types: ["object.upserted"] })
  }

  created(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "created" in selector) {
      return this.withSelectorSpec(selector.created())
    }
    return this
  }

  updated(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "updated" in selector) {
      return this.withSelectorSpec(selector.updated())
    }
    return this
  }

  deleted(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "deleted" in selector) {
      return this.withSelectorSpec(selector.deleted())
    }
    return this
  }

  linked(link?: LinkToken): EventsBuilderImpl {
    return this.withFilter({
      topic: "links",
      types: ["link.upserted", "link.removed"],
      ...(link ? { linkId: link.id } : {}),
    })
  }

  link(link: LinkToken): EventsBuilderImpl {
    const objectType = this.params.objectType
    if (!objectType) {
      throw new Error("[SixbClient] Link event selectors require an object type.")
    }
    const selector = selectEvents.object(objectType).link(link)
    return new EventsBuilderImpl({
      ...this.params,
      linkToken: link,
      selector,
      filter: {
        ...this.params.filter,
        ...eventSelectorSpec(selector),
        types: ["link.created", "link.updated", "link.deleted"],
      },
    })
  }

  removed(): EventsBuilderImpl {
    return this.deleted()
  }

  cleared(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "cleared" in selector) {
      return this.withSelectorSpec(selector.cleared())
    }
    return this
  }

  byId(primaryId: string): EventsBuilderImpl {
    return this.withFilter({ primaryId })
  }

  run(runId: string): EventsBuilderImpl {
    return this.withFilter({ runId })
  }

  action(actionId: string): EventsBuilderImpl {
    return this.withFilter({ actionId })
  }

  subject(objectType: ObjectTypeWithTokens | string): EventsBuilderImpl {
    const objectTypeId = typeof objectType === "string" ? objectType : objectType.id
    return this.withFilter({ objectTypeId })
  }

  requested(): EventsBuilderImpl {
    return this.withFilter({ topic: "actions", types: ["action.requested"] })
  }

  completed(): EventsBuilderImpl {
    return this.withFilter({ topic: "actions", types: ["action.completed"] })
  }

  failed(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "failed" in selector) {
      return this.withSelectorSpec(selector.failed())
    }
    return this.withFilter({ topic: "actions", types: ["action.failed"] })
  }

  succeeded(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "succeeded" in selector) {
      return this.withSelectorSpec(selector.succeeded())
    }
    return this
  }

  cancelled(): EventsBuilderImpl {
    const selector = this.params.selector
    if (selector && "cancelled" in selector) {
      return this.withSelectorSpec(selector.cancelled())
    }
    return this
  }

  terminal(): EventsBuilderImpl {
    return this.withFilter({ topic: "actions", types: ["action.completed", "action.failed"] })
  }

  triggered(): EventsBuilderImpl {
    return this.withFilter({ topic: "rules", types: ["rule.triggered"] })
  }

  resolved(): EventsBuilderImpl {
    return this.withFilter({ topic: "rules", types: ["rule.resolved"] })
  }

  subscribe(handler: (event: SixbEvent) => void, options?: EventSubscribeOptions): () => void {
    return this.params.executor.subscribe(this.params.filter, handler, options)
  }

  private withFilter(delta: Partial<EventsFilterSpec>): EventsBuilderImpl {
    return new EventsBuilderImpl({
      ...this.params,
      filter: { ...this.params.filter, ...delta },
    })
  }

  private withSelector(selector: CoreEventSelector): EventsBuilderImpl {
    return new EventsBuilderImpl({
      ...this.params,
      selector,
      filter: { ...this.params.filter, ...eventSelectorSpec(selector) },
    })
  }

  private withSelectorSpec(selector: EventSelectorSpec<unknown>): EventsBuilderImpl {
    return new EventsBuilderImpl({
      ...this.params,
      filter: { ...this.params.filter, ...eventSelectorSpec(selector) },
    })
  }
}

function createBuilder(
  filter: EventsFilterSpec,
  options?: SixbEventsClientOptions,
  params: Pick<EventsBuilderParams, "objectType" | "linkToken" | "selector"> = {}
): EventsBuilderImpl {
  return new EventsBuilderImpl({ filter, executor: createWsSubscribeExecutor(options), ...params })
}

function createPropertySelectorMap(
  tokens: Record<string, PropertyToken>,
  createSelector: (property: PropertyToken) => EventsBuilderImpl
): Record<string, EventPropertyBuilder<ObjectTypeWithTokens>> {
  return Object.fromEntries(
    Object.entries(tokens).map(([propertyId, token]) => [propertyId, createSelector(token)])
  ) as Record<string, EventPropertyBuilder<ObjectTypeWithTokens>>
}

function createLinkPropertyTokens(linkToken: LinkToken): Record<string, PropertyToken> {
  return Object.fromEntries(
    (linkToken.link.properties ?? []).map((property) => [
      property.id,
      {
        objectTypeId: linkToken.objectTypeId,
        id: property.id,
        property,
      } satisfies PropertyToken,
    ])
  )
}

// ── Public `events` namespace ────────────────────────────────────────────────

export interface SixbEventsClientOptions {
  /** hey-api client override (base url). Defaults to the global client. */
  client?: Client
}

export interface SixbEventsApi {
  /** Events for one object type, narrowed by channel + `.byId(key)`. */
  object<TObjectType extends ObjectTypeWithTokens>(
    objectType: TObjectType,
    options?: SixbEventsClientOptions
  ): EventsBuilder<TObjectType>

  /** Every event (the unscoped catch-all stream). */
  all(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEvent>
  objects(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"objects">>
  telemetry(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"telemetry">>
  links(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"links">>
  actions(options?: SixbEventsClientOptions): EventsActionBuilder<SixbEventOfTopic<"actions">>
  action<TAction extends ActionDefinition>(
    action: TAction,
    options?: SixbEventsClientOptions
  ): EventsActionBuilder<SixbEventOfTopic<"actions">>
  rule<TRule extends RuleDefinition>(
    rule: TRule,
    options?: SixbEventsClientOptions
  ): EventsRuleBuilder<SixbEventOfTopic<"rules">>
  dataset<TDataset extends DatasetDefinition>(
    dataset: TDataset,
    options?: SixbEventsClientOptions
  ): EventsDatasetBuilder<TDataset, SixbEventOfTopic<"datasets">>
  sync<TSync extends SyncDefinition>(
    sync: TSync,
    options?: SixbEventsClientOptions
  ): EventsSyncBuilder<TSync, SixbEventOfTopic<"syncs">>
  pipeline<TPipeline extends PipelineDefinition>(
    pipeline: TPipeline,
    options?: SixbEventsClientOptions
  ): EventsPipelineBuilder<TPipeline, SixbEventOfTopic<"pipelines">>
  schedules(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"schedules">>
  rules(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"rules">>
  datasets(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"datasets">>
  workflows(options?: SixbEventsClientOptions): EventsRunBuilder<SixbEventOfTopic<"workflows">>
  pipelines(options?: SixbEventsClientOptions): EventsRunBuilder<SixbEventOfTopic<"pipelines">>
  syncs(options?: SixbEventsClientOptions): EventsRunBuilder<SixbEventOfTopic<"syncs">>
}

function topicBuilder<TEvent extends SixbEvent>(
  topic: SixbEventTopic,
  options?: SixbEventsClientOptions
): EventsTopicBuilder<TEvent> {
  return createBuilder({ topic }, options) as unknown as EventsTopicBuilder<TEvent>
}

function runBuilder<TEvent extends SixbEvent>(
  topic: SixbEventTopic,
  options?: SixbEventsClientOptions
): EventsRunBuilder<TEvent> {
  return createBuilder({ topic }, options) as unknown as EventsRunBuilder<TEvent>
}

function actionBuilder<TEvent extends SixbEvent>(
  options?: SixbEventsClientOptions
): EventsActionBuilder<TEvent> {
  return createBuilder({ topic: "actions" }, options) as unknown as EventsActionBuilder<TEvent>
}

const eventsApi = {} as SixbEventsApi

eventsApi.object = (objectType, options) => {
  const selector = selectEvents.object(objectType)
  return createBuilder(eventSelectorSpec(selector), options, {
    objectType,
    selector: selector as CoreObjectEventSelectorBuilder<ObjectTypeWithTokens>,
  }) as unknown as EventsBuilder<typeof objectType>
}

eventsApi.all = (options) => createBuilder({}, options) as unknown as EventsTopicBuilder<SixbEvent>
eventsApi.objects = (options) => topicBuilder("objects", options)
eventsApi.telemetry = (options) => topicBuilder("telemetry", options)
eventsApi.links = (options) => topicBuilder("links", options)
eventsApi.actions = (options) => actionBuilder(options)
eventsApi.action = (action, options) =>
  createBuilder(
    { topic: "actions", actionId: action.id },
    options
  ) as unknown as EventsActionBuilder<SixbEventOfTopic<"actions">>
eventsApi.rule = (rule, options) =>
  createBuilder({ topic: "rules", ruleId: rule.id }, options) as unknown as EventsRuleBuilder<
    SixbEventOfTopic<"rules">
  >
eventsApi.dataset = (dataset, options) => {
  const selector = selectEvents.dataset(dataset)
  return createBuilder(eventSelectorSpec(selector), options, {
    selector: selector as CoreDatasetEventSelectorBuilder<DatasetEventToken>,
  }) as unknown as EventsDatasetBuilder<typeof dataset, SixbEventOfTopic<"datasets">>
}
eventsApi.sync = (sync, options) => {
  const selector = selectEvents.sync(sync)
  return createBuilder(eventSelectorSpec(selector), options, {
    selector: selector as CoreSyncEventSelectorBuilder<SyncEventToken>,
  }) as unknown as EventsSyncBuilder<typeof sync, SixbEventOfTopic<"syncs">>
}
eventsApi.pipeline = (pipeline, options) => {
  const selector = selectEvents.pipeline(pipeline)
  return createBuilder(eventSelectorSpec(selector), options, {
    selector: selector as CorePipelineEventSelectorBuilder<PipelineEventToken>,
  }) as unknown as EventsPipelineBuilder<typeof pipeline, SixbEventOfTopic<"pipelines">>
}
eventsApi.schedules = (options) => topicBuilder("schedules", options)
eventsApi.rules = (options) => topicBuilder("rules", options)
eventsApi.datasets = (options) => topicBuilder("datasets", options)
eventsApi.workflows = (options) => runBuilder("workflows", options)
eventsApi.pipelines = (options) => runBuilder("pipelines", options)
eventsApi.syncs = (options) => runBuilder("syncs", options)

export const events: SixbEventsApi = eventsApi
