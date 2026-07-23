import { randomUUID } from "node:crypto"
import type { Broker, BrokerCursor, BrokerRecord, BrokerStreamDefinition } from "../broker"
import { getInvalidJsonValueReason, type JsonValue } from "../json"
import type { OntologyMaterializationEvent } from "../materialization/events"
import {
  EVENT_DEFINITIONS,
  EVENT_TYPES,
  isDomainEventType,
  resolveEventStorage,
} from "./definitions"
import { EventsError } from "./errors"
import type { DomainEvent, EventActor, EventDraft, StoredDomainEvent } from "./types"

// Keep domain events as a short recent log. This is 2 days in milliseconds.
export const DEFAULT_EVENTS_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

export const EVENTS_STREAM: BrokerStreamDefinition = {
  id: "__events",
  retention: { maxAgeMs: DEFAULT_EVENTS_RETENTION_MS },
}

export interface EventsRuntimeOptions {
  readonly projectId: string
  readonly broker: Broker
  readonly stream?: BrokerStreamDefinition
}

export interface EventsAppendInput {
  readonly actor?: EventActor
  readonly correlationId?: string
  readonly causationId?: string
  readonly events: readonly EventDraft[]
}

export interface EventsReadInput {
  readonly afterCursor?: string
  readonly limit?: number
  readonly topics?: readonly DomainEvent["topic"][]
  readonly types?: readonly DomainEvent["type"][]
}

export interface EventsSubscribeInput {
  /** Defaults to live-only delivery. `afterCursor` takes precedence when provided. */
  readonly from?: "latest" | "earliest"
  readonly afterCursor?: BrokerCursor
  readonly types?: readonly DomainEvent["type"][]
}

/** Exact, already-identified materialization event persisted before broker publication. @internal */
export type StableEventEnvelope = OntologyMaterializationEvent

/** Project-scoped domain event runtime backed by the shared broker provider. */
export class EventsRuntime {
  private readonly projectId: string
  private readonly broker: Broker
  private readonly stream: BrokerStreamDefinition
  private readonly ensureStreamPromises = new Map<string, Promise<void>>()

  constructor(options: EventsRuntimeOptions) {
    this.projectId = options.projectId
    this.broker = options.broker
    this.stream = options.stream ?? EVENTS_STREAM
  }

  async append(input: EventsAppendInput): Promise<readonly StoredDomainEvent[]> {
    if (input.events.length === 0) {
      return []
    }

    const payloads = input.events.map((event) =>
      toStoredEventPayload({
        projectId: this.projectId,
        actor: input.actor,
        correlationId: input.correlationId,
        causationId: input.causationId,
        event,
      })
    )

    await this.ensureStream()
    const records = await this.broker.append({
      projectId: this.projectId,
      streamId: this.stream.id,
      records: payloads.map((payload) => ({
        name: payload.type,
        key: payload.partitionKey,
        payload: toBrokerRecordPayload(payload),
        idempotencyKey: payload.idempotencyKey,
      })),
    })

    if (records.length !== payloads.length) {
      throw new EventsError(
        `Broker returned ${records.length} record(s) for ${payloads.length} appended event(s).`
      )
    }

    return records.map(hydrateEventRecord)
  }

  /** Publishes persisted envelopes without changing their stable event identity. @internal */
  async publishEnvelopes(
    envelopes: readonly StableEventEnvelope[]
  ): Promise<readonly StoredDomainEvent[]> {
    if (envelopes.length === 0) {
      return []
    }

    for (const envelope of envelopes) {
      if (envelope.projectId !== this.projectId) {
        throw new EventsError(
          `Event '${envelope.id}' belongs to project '${envelope.projectId}', not '${this.projectId}'.`
        )
      }
      if (!isDomainEventType(envelope.type)) {
        throw new EventsError(`Event '${envelope.id}' has unknown event type.`)
      }
      if (EVENT_DEFINITIONS[envelope.type].topic !== envelope.topic) {
        throw new EventsError(
          `Event '${envelope.id}' topic '${envelope.topic}' does not match type '${envelope.type}'.`
        )
      }
    }

    await this.ensureStream()
    const records = await this.broker.append({
      projectId: this.projectId,
      streamId: this.stream.id,
      records: envelopes.map((envelope) => ({
        name: envelope.type,
        key: envelope.partitionKey,
        payload: toBrokerRecordPayload(envelope),
        idempotencyKey: envelope.id,
      })),
    })

    if (records.length !== envelopes.length) {
      throw new EventsError(
        `Broker returned ${records.length} record(s) for ${envelopes.length} published event(s).`
      )
    }

    return records.map(hydrateEventRecord)
  }

  async read(input: EventsReadInput = {}): Promise<readonly StoredDomainEvent[]> {
    if (input.limit !== undefined && input.limit <= 0) {
      return []
    }

    const names = resolveTypeFilter(input)
    if (names && names.length === 0) {
      return []
    }

    await this.ensureStream()
    const page = await this.broker.read({
      projectId: this.projectId,
      streamId: this.stream.id,
      afterCursor: input.afterCursor,
      limit: input.limit,
      names,
    })

    return page.records.map(hydrateEventRecord)
  }

  async latestCursor(): Promise<string | undefined> {
    await this.ensureStream()
    return this.broker.latestCursor({
      projectId: this.projectId,
      streamId: this.stream.id,
    })
  }

  async subscribe(
    input: EventsSubscribeInput,
    handler: (events: readonly StoredDomainEvent[]) => void
  ): Promise<() => void> {
    await this.ensureStream()
    return this.broker.subscribe(
      {
        projectId: this.projectId,
        streamId: this.stream.id,
        from: input.from,
        afterCursor: input.afterCursor,
        names: input.types && input.types.length > 0 ? input.types : EVENT_TYPES,
      },
      (records) => {
        const events = records.map(hydrateEventRecord)
        if (events.length === 0) {
          return
        }

        try {
          handler(events)
        } catch {
          // Preserve fire-and-forget subscriber semantics.
        }
      }
    )
  }

  private ensureStream(): Promise<void> {
    const key = `${this.projectId}\0${this.stream.id}`
    let promise = this.ensureStreamPromises.get(key)
    if (!promise) {
      promise = this.broker
        .ensureStream({
          projectId: this.projectId,
          stream: this.stream,
        })
        .catch((error) => {
          if (this.ensureStreamPromises.get(key) === promise) {
            this.ensureStreamPromises.delete(key)
          }
          throw error
        })
      this.ensureStreamPromises.set(key, promise)
    }
    return promise
  }
}

type StoredEventPayload = Omit<StoredDomainEvent, "cursor">

function toStoredEventPayload(params: {
  projectId: string
  actor?: EventActor
  correlationId?: string
  causationId?: string
  event: EventDraft
}): StoredEventPayload {
  const storage = resolveEventStorage(params.event)
  const payload: Record<string, unknown> = {
    id: randomUUID(),
    schemaVersion: 1,
    projectId: params.projectId,
    occurredAt: params.event.occurredAt ?? new Date().toISOString(),
    type: params.event.type,
    topic: storage.topic,
    partitionKey: storage.partitionKey,
    payload: params.event.payload,
  }

  setIfDefined(payload, "correlationId", params.correlationId)
  setIfDefined(payload, "causationId", params.causationId)
  setIfDefined(payload, "idempotencyKey", params.event.idempotencyKey)
  setIfDefined(payload, "actor", params.actor)
  setIfDefined(payload, "origin", params.event.origin)
  setIfDefined(payload, "metadata", params.event.metadata)

  return payload as StoredEventPayload
}

function toBrokerRecordPayload(payload: StoredEventPayload | StableEventEnvelope): JsonValue {
  const reason = getInvalidJsonValueReason(payload, `event '${payload.type}' payload`)
  if (reason) {
    throw new EventsError(`Event '${payload.type}' cannot be stored in broker; ${reason}`)
  }

  return payload as unknown as JsonValue
}

function hydrateEventRecord(record: BrokerRecord): StoredDomainEvent {
  const payload = record.payload
  if (!isObjectRecord(payload)) {
    throw new EventsError(`Broker record at cursor '${record.cursor}' is not an event object.`)
  }

  const eventType = payload.type
  if (typeof eventType !== "string" || !isDomainEventType(eventType)) {
    throw new EventsError(`Broker record at cursor '${record.cursor}' has unknown event type.`)
  }

  if (record.name !== undefined && record.name !== eventType) {
    throw new EventsError(
      `Broker record name '${record.name}' does not match event type '${eventType}'.`
    )
  }

  return {
    ...payload,
    cursor: record.cursor,
  } as StoredDomainEvent
}

function resolveTypeFilter(input: {
  topics?: readonly DomainEvent["topic"][]
  types?: readonly DomainEvent["type"][]
}): readonly DomainEvent["type"][] {
  const topicTypes =
    input.topics && input.topics.length > 0
      ? EVENT_TYPES.filter((type) => input.topics?.includes(EVENT_DEFINITIONS[type].topic))
      : undefined

  if (!topicTypes) {
    return input.types && input.types.length > 0 ? input.types : EVENT_TYPES
  }

  if (!input.types || input.types.length === 0) {
    return topicTypes
  }

  const requestedTypes = new Set(input.types)
  return topicTypes.filter((type) => requestedTypes.has(type))
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value
  }
}
