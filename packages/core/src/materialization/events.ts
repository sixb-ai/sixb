import type { LinkDeletedEventPayload, LinkMutationEventPayload } from "../events/types/links"
import type { ObjectDeletedEventPayload, ObjectMutationEventPayload } from "../events/types/objects"
import type { TelemetryAppendedEventPayload } from "../events/types/telemetry"
import type {
  AuthorizablePrincipal,
  KernelOperation,
  TrustedPrimitiveKind,
} from "../execution/types"
import type { JsonValue } from "../json"
import type {
  OntologyMaterializationOrigin,
  OntologyMaterializationPropertyChangeMap,
} from "./model"

/**
 * Workload that made an ontology change, copied from its execution.
 *
 * It names what ran; `requestedBy` names on whose behalf. A primitive carries its definition id so
 * a consumer can tell which workflow, sync, or webhook wrote without reading the run. An Agent
 * `runId` is its Agent run, or the step run of a Workflow Agent step.
 */
export type EventExecutor =
  | { readonly type: "request"; readonly requestId: string }
  | {
      readonly type: "primitive"
      readonly kind: TrustedPrimitiveKind
      readonly id: string
      readonly runId: string
    }
  | { readonly type: "agent"; readonly runId: string }
  | { readonly type: "kernel"; readonly operation: KernelOperation }

interface OntologyMaterializationEventBase {
  readonly id: string
  readonly schemaVersion: 1
  readonly projectId: string
  readonly occurredAt: string
  readonly correlationId: string
  /** Principal on whose behalf the write ran; absent for automatic or anonymous work. */
  readonly requestedBy?: AuthorizablePrincipal
  /** Workload that made the write. */
  readonly executor: EventExecutor
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

type OntologyMaterializationEventKind = OntologyMaterializationEvent["type"]

type EventPayload<K extends OntologyMaterializationEventKind> =
  OntologyMaterializationEvent extends infer E
    ? E extends { readonly type: infer T; readonly payload: infer P }
      ? K extends T
        ? P
        : never
      : never
    : never

type EventDraftOf<K> = K extends OntologyMaterializationEventKind
  ? {
      readonly type: K
      readonly payload: K extends "object.created" | "link.created"
        ? Readonly<Omit<EventPayload<K>, "propertyChanges">>
        : EventPayload<K>
    }
  : never

/**
 * An event as core stages it and storage keeps it: what changed, and nothing it can be rebuilt
 * from. `materializationEvent` adds back the context its commit and execution share with every
 * other event of that commit, the partition key and topic its type and payload fix, and the
 * property changes of a creation, which only restate its properties.
 */
export type OntologyMaterializationEventDraft = EventDraftOf<OntologyMaterializationEventKind>

/** The commit fields every event of that commit carries. */
export interface OntologyMaterializationEventCommit {
  readonly projectId: string
  readonly id: string
  readonly committedAt: string
  readonly origin: OntologyMaterializationOrigin
}

/** Who asked for a commit and what wrote it, as its events carry them: read from its execution. */
export interface OntologyMaterializationEventAttribution {
  readonly correlationId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly executor: EventExecutor
}
