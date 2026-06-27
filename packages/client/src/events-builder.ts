/**
 * Fluent event-subscription builder (`@sixb/client/events`).
 *
 * `events(Type)` mirrors `objects(Type)`: an immutable, generic-threaded builder
 * that accumulates an event-filter IR and types the payload from the same
 * `Type.p.*` / `Type.l.*` tokens as `expand()`. Channels (`.telemetry()`,
 * `.upserted()`, `.deleted()`, `.linked()`) narrow both the event type and the
 * payload; `.object(key)` scopes to one instance. The single core terminal is
 * `.subscribe(handler) => unsubscribe`, which runs a client-side predicate over
 * the live stream. The builder is browser-safe and React-free — hooks live in
 * `@sixb/client/hooks`.
 */
import type { InferObjectProperties, InferPropertyValue } from "@sixb/core"
import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "@sixb/core/ontology"
import type {
  SixbEvent,
  SixbEventOfTopic,
  SixbEventOfType,
  SixbEventTopic,
  SixbEventType,
} from "./events"
import { createEventSocket, type EventSocketState } from "./events-transport"
import type { Client } from "./generated/client"

/**
 * Conjunctive event-filter scope. Event subscriptions are a single flat scope
 * (not a query tree), so the IR is a flat record rather than nested nodes.
 */
export interface EventsFilterIR {
  readonly topic?: SixbEventTopic
  readonly types?: readonly SixbEventType[]
  /** `Type.id` when built from `events(Type)`. */
  readonly objectTypeId?: string
  /** `.object(key)` instance scope (objects / telemetry / links). */
  readonly primaryId?: string
  /** `.telemetry(token)` property scope. */
  readonly propertyId?: string
  /** `.linked(token)` link scope. */
  readonly linkId?: string
  /** `.run(runId)` scope (workflows / pipelines / syncs). */
  readonly runId?: string
}

// ── Payload typing ──────────────────────────────────────────────────────────
// Flat, named conditionals keyed on the channel — never a recursive resolver —
// and `TValueTypes` is always pinned to `readonly []` so property-value
// inference stays shallow enough for TypeScript's recursion limits (no TS2589).

type Override<TBase, TPatch> = Omit<TBase, keyof TPatch> & TPatch

type StoredTelemetryEvent = SixbEventOfType<"telemetry.appended">
type StoredObjectUpsertedEvent = SixbEventOfType<"object.upserted">

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
  readonly onError?: (error: string) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

/** Object-scoped builder: `events(Type)`. Channels narrow the event + payload. */
export interface EventsBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TEvent extends SixbEvent = ObjectScopedEvent,
> {
  /** Accumulated event-filter IR. */
  readonly ir: EventsFilterIR

  /** Telemetry appends, optionally narrowed to one property's typed value. */
  telemetry<TToken extends PropertyToken<TObjectType["id"]> | undefined = undefined>(
    property?: TToken
  ): EventsBuilder<TObjectType, TelemetryEventForProperty<TToken>>

  /** Object upserts, with ontology-typed `payload.properties`. */
  upserted(): EventsBuilder<TObjectType, ObjectUpsertedEventOf<TObjectType>>

  /** Object deletions. */
  deleted(): EventsBuilder<TObjectType, SixbEventOfType<"object.deleted">>

  /** Outgoing link changes, optionally narrowed to one link. */
  linked<TToken extends LinkToken<TObjectType["id"]> | undefined = undefined>(
    link?: TToken
  ): EventsBuilder<TObjectType, SixbEventOfTopic<"links">>

  /** Scope to a single object instance (orthogonal to the channel). */
  object(primaryId: string): EventsBuilder<TObjectType, TEvent>

  /** Subscribe to matching events; returns an unsubscribe function. */
  subscribe(handler: (event: TEvent) => void, options?: EventSubscribeOptions): () => void
}

/** Topic-scoped builder: `events.telemetry()`, `events.all()`, … */
export interface EventsTopicBuilder<TEvent extends SixbEvent> {
  readonly ir: EventsFilterIR
  subscribe(handler: (event: TEvent) => void, options?: EventSubscribeOptions): () => void
}

/** Run-scoped topic builder: `events.workflows()`, `events.pipelines()`, `events.syncs()`. */
export interface EventsRunBuilder<TEvent extends SixbEvent> extends EventsTopicBuilder<TEvent> {
  /** Scope to a single run id. */
  run(runId: string): EventsRunBuilder<TEvent>
}

/**
 * The minimal builder contract the React hooks consume: a filter IR plus a
 * typed `subscribe`. Every builder surface satisfies it, and the hooks infer
 * the event type `TEvent` from the builder they are handed.
 */
export interface SubscribableEvents<TEvent extends SixbEvent> {
  readonly ir: EventsFilterIR
  subscribe(handler: (event: TEvent) => void, options?: EventSubscribeOptions): () => void
}

// ── Subscribe executor (the transport seam) ───────────────────────────────────

export interface EventSubscribeExecutor {
  subscribe(
    filter: EventsFilterIR,
    handler: (event: SixbEvent) => void,
    options?: EventSubscribeOptions
  ): () => void
}

/**
 * WebSocket-backed executor. The transport receives the coarse `topic`/`types`
 * subscription; the finer scope (objectTypeId / primaryId / propertyId / linkId
 * / runId) is applied client-side by `buildEventPredicate` before the handler
 * runs — exactly the manual filtering every call site reimplements today.
 */
export function createWsSubscribeExecutor(options?: { client?: Client }): EventSubscribeExecutor {
  const baseUrl = options?.client?.getConfig().baseUrl
  return {
    subscribe(filter, handler, subscribeOptions) {
      const matches = buildEventPredicate(filter)
      const socket = createEventSocket({
        topic: filter.topic,
        types: filter.types,
        afterCursor: subscribeOptions?.afterCursor,
        limit: subscribeOptions?.limit,
        reconnect: subscribeOptions?.reconnect,
        reconnectDelayMs: subscribeOptions?.reconnectDelayMs,
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
 * Pure predicate that narrows the live stream to the builder's IR. Reads the
 * topic-specific payload keys directly: objects use `primaryId`, telemetry uses
 * `objectId`, links use the source side.
 */
export function buildEventPredicate(filter: EventsFilterIR): (event: SixbEvent) => boolean {
  return (event) => {
    if (filter.topic && event.topic !== filter.topic) return false
    if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) return false

    const payload = event.payload as Record<string, unknown>

    if (
      filter.objectTypeId !== undefined &&
      eventObjectTypeId(event, payload) !== filter.objectTypeId
    ) {
      return false
    }
    if (filter.primaryId !== undefined && eventPrimaryId(event, payload) !== filter.primaryId) {
      return false
    }
    if (filter.propertyId !== undefined && payload.propertyId !== filter.propertyId) return false
    if (filter.linkId !== undefined && payload.linkId !== filter.linkId) return false
    if (filter.runId !== undefined && payload.runId !== filter.runId) return false

    return true
  }
}

function eventObjectTypeId(event: SixbEvent, payload: Record<string, unknown>): unknown {
  return event.topic === "links" ? payload.sourceTypeId : payload.objectTypeId
}

function eventPrimaryId(event: SixbEvent, payload: Record<string, unknown>): unknown {
  if (event.topic === "telemetry") return payload.objectId
  if (event.topic === "links") return payload.sourceId
  return payload.primaryId
}

// ── Runtime backing ───────────────────────────────────────────────────────────

type EventsBuilderParams = {
  readonly filter: EventsFilterIR
  readonly executor: EventSubscribeExecutor
}

/**
 * One immutable implementation backs every builder surface. Each method returns
 * a fresh instance (copy-on-write on the IR), and the factory functions cast it
 * to the surface that exposes the right methods — mirroring the object query
 * builder's `as unknown as` seam.
 */
class EventsBuilderImpl {
  constructor(private readonly params: EventsBuilderParams) {}

  get ir(): EventsFilterIR {
    return this.params.filter
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

  deleted(): EventsBuilderImpl {
    return this.withFilter({ topic: "objects", types: ["object.deleted"] })
  }

  linked(link?: LinkToken): EventsBuilderImpl {
    return this.withFilter({
      topic: "links",
      types: ["link.upserted", "link.removed"],
      ...(link ? { linkId: link.id } : {}),
    })
  }

  object(primaryId: string): EventsBuilderImpl {
    return this.withFilter({ primaryId })
  }

  run(runId: string): EventsBuilderImpl {
    return this.withFilter({ runId })
  }

  subscribe(handler: (event: SixbEvent) => void, options?: EventSubscribeOptions): () => void {
    return this.params.executor.subscribe(this.params.filter, handler, options)
  }

  private withFilter(delta: Partial<EventsFilterIR>): EventsBuilderImpl {
    return new EventsBuilderImpl({
      ...this.params,
      filter: { ...this.params.filter, ...delta },
    })
  }
}

function createBuilder(
  filter: EventsFilterIR,
  options?: SixbEventsClientOptions
): EventsBuilderImpl {
  return new EventsBuilderImpl({ filter, executor: createWsSubscribeExecutor(options) })
}

// ── Public `events` callable + topic namespace ────────────────────────────────

export interface SixbEventsClientOptions {
  /** hey-api client override (base url). Defaults to the global client. */
  client?: Client
}

export interface SixbEventsApi {
  /** Events for one object type, narrowed by channel + `.object(key)`. */
  <TObjectType extends ObjectTypeWithTokens>(
    objectType: TObjectType,
    options?: SixbEventsClientOptions
  ): EventsBuilder<TObjectType>

  /** Every event (the `useSixbEvents()` default). */
  all(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEvent>
  objects(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"objects">>
  telemetry(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"telemetry">>
  links(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"links">>
  actions(options?: SixbEventsClientOptions): EventsTopicBuilder<SixbEventOfTopic<"actions">>
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

const eventsApi = (<TObjectType extends ObjectTypeWithTokens>(
  objectType: TObjectType,
  options?: SixbEventsClientOptions
): EventsBuilder<TObjectType> =>
  createBuilder(
    { objectTypeId: objectType.id },
    options
  ) as unknown as EventsBuilder<TObjectType>) as SixbEventsApi

eventsApi.all = (options) => createBuilder({}, options) as unknown as EventsTopicBuilder<SixbEvent>
eventsApi.objects = (options) => topicBuilder("objects", options)
eventsApi.telemetry = (options) => topicBuilder("telemetry", options)
eventsApi.links = (options) => topicBuilder("links", options)
eventsApi.actions = (options) => topicBuilder("actions", options)
eventsApi.schedules = (options) => topicBuilder("schedules", options)
eventsApi.rules = (options) => topicBuilder("rules", options)
eventsApi.datasets = (options) => topicBuilder("datasets", options)
eventsApi.workflows = (options) => runBuilder("workflows", options)
eventsApi.pipelines = (options) => runBuilder("pipelines", options)
eventsApi.syncs = (options) => runBuilder("syncs", options)

export const events: SixbEventsApi = eventsApi
