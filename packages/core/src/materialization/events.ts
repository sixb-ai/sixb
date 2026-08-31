import type { EventActor } from "../events/envelope"
import type { LinkDeletedEventPayload, LinkMutationEventPayload } from "../events/types/links"
import type { ObjectDeletedEventPayload, ObjectMutationEventPayload } from "../events/types/objects"
import type { TelemetryAppendedEventPayload } from "../events/types/telemetry"
import type { JsonValue } from "../json"
import type {
  OntologyMaterializationOrigin,
  OntologyMaterializationPropertyChangeMap,
} from "./model"

interface OntologyMaterializationEventBase {
  readonly id: string
  readonly schemaVersion: 1
  readonly projectId: string
  readonly occurredAt: string
  readonly correlationId: string
  readonly actor?: EventActor
  readonly origin: OntologyMaterializationOrigin
  readonly commitId: string
  readonly commitOrdinal: number
  readonly partitionKey: string
}

interface ReadonlyMaterializationPropertyChanges {
  readonly propertyChanges: OntologyMaterializationPropertyChangeMap
}

type ReadonlyDeletedMaterializationPayload<TPayload> = Readonly<
  Omit<TPayload, "propertyChanges"> & ReadonlyMaterializationPropertyChanges
>

type ReadonlyObjectMutationMaterializationPayload = Readonly<
  Omit<ObjectMutationEventPayload<JsonValue>, "properties" | "propertyChanges"> &
    ReadonlyMaterializationPropertyChanges & {
      readonly properties: Readonly<Record<string, JsonValue>>
    }
>

type ReadonlyLinkMutationMaterializationPayload = Readonly<
  Omit<LinkMutationEventPayload<JsonValue>, "properties" | "propertyChanges"> &
    ReadonlyMaterializationPropertyChanges & {
      readonly properties?: Readonly<Record<string, JsonValue>>
    }
>

type OntologyObjectMaterializationEvent = OntologyMaterializationEventBase &
  (
    | {
        readonly type: "object.created" | "object.updated"
        readonly topic: "objects"
        readonly payload: ReadonlyObjectMutationMaterializationPayload
      }
    | {
        readonly type: "object.deleted"
        readonly topic: "objects"
        readonly payload: ReadonlyDeletedMaterializationPayload<
          ObjectDeletedEventPayload<JsonValue>
        >
      }
  )

type OntologyLinkMaterializationEvent = OntologyMaterializationEventBase &
  (
    | {
        readonly type: "link.created" | "link.updated"
        readonly topic: "links"
        readonly payload: ReadonlyLinkMutationMaterializationPayload
      }
    | {
        readonly type: "link.deleted"
        readonly topic: "links"
        readonly payload: ReadonlyDeletedMaterializationPayload<LinkDeletedEventPayload<JsonValue>>
      }
  )

type OntologyTelemetryMaterializationEvent = OntologyMaterializationEventBase & {
  readonly type: "telemetry.appended"
  readonly topic: "telemetry"
  readonly payload: Readonly<TelemetryAppendedEventPayload<JsonValue>>
}

/** Exact JSON-safe domain event stored transactionally before broker publication. */
export type OntologyMaterializationEvent =
  | OntologyObjectMaterializationEvent
  | OntologyLinkMaterializationEvent
  | OntologyTelemetryMaterializationEvent

type WithoutEventSequence<T> = T extends OntologyMaterializationEvent
  ? Omit<T, "id" | "commitOrdinal">
  : never

/** Complete core-authored event fact before contiguous commit sequencing is assigned. */
export type OntologyMaterializationEventDraft = WithoutEventSequence<OntologyMaterializationEvent>
