import type { EventActor } from "../../events/envelope"
import type { JsonValue } from "../../json"
import type {
  OntologyMaterializationOrigin,
  OntologyMaterializationPropertyChangeMap,
} from "../../materialization/model"

interface OntologyMaterializationEventBase {
  readonly id: string
  readonly schemaVersion: 1
  readonly projectId: string
  readonly occurredAt: string
  readonly actor?: EventActor
  readonly origin: OntologyMaterializationOrigin
  readonly commitId: string
  readonly commitOrdinal: number
  readonly partitionKey: string
}

type OntologyObjectMaterializationEvent = OntologyMaterializationEventBase &
  (
    | {
        readonly type: "object.created" | "object.updated"
        readonly topic: "objects"
        readonly payload: {
          readonly objectTypeId: string
          readonly primaryId: string
          readonly properties: Readonly<Record<string, JsonValue>>
          readonly propertyChanges: OntologyMaterializationPropertyChangeMap
        }
      }
    | {
        readonly type: "object.deleted"
        readonly topic: "objects"
        readonly payload: {
          readonly objectTypeId: string
          readonly primaryId: string
          readonly propertyChanges: OntologyMaterializationPropertyChangeMap
        }
      }
  )

type OntologyLinkMaterializationEvent = OntologyMaterializationEventBase &
  (
    | {
        readonly type: "link.created" | "link.updated"
        readonly topic: "links"
        readonly payload: {
          readonly sourceTypeId: string
          readonly sourceId: string
          readonly linkId: string
          readonly targetTypeId: string
          readonly targetId: string
          readonly properties?: Readonly<Record<string, JsonValue>>
          readonly propertyChanges: OntologyMaterializationPropertyChangeMap
        }
      }
    | {
        readonly type: "link.deleted"
        readonly topic: "links"
        readonly payload: {
          readonly sourceTypeId: string
          readonly sourceId: string
          readonly linkId: string
          readonly targetTypeId: string
          readonly targetId: string
          readonly propertyChanges: OntologyMaterializationPropertyChangeMap
        }
      }
  )

type OntologyTelemetryMaterializationEvent = OntologyMaterializationEventBase & {
  readonly type: "telemetry.appended"
  readonly topic: "telemetry"
  readonly payload: {
    readonly objectTypeId: string
    readonly objectId: string
    readonly propertyId: string
    readonly value: JsonValue
    readonly unit?: string
    readonly at: string
  }
}

/** JSON-safe post-commit facts persisted in the ontology outbox. */
export type OntologyMaterializationEvent =
  | OntologyObjectMaterializationEvent
  | OntologyLinkMaterializationEvent
  | OntologyTelemetryMaterializationEvent

type WithoutEventSequence<T> = T extends OntologyMaterializationEvent
  ? Omit<T, "id" | "commitOrdinal">
  : never

/** Complete core-authored event fact before contiguous commit sequencing is assigned. */
export type OntologyMaterializationEventDraft = WithoutEventSequence<OntologyMaterializationEvent>

export interface OntologyOutboxWrite {
  /** Providers may index envelope identity fields, but the envelope remains authoritative. */
  readonly envelope: OntologyMaterializationEvent
  readonly availableAt: string
  readonly createdAt: string
}

export interface OntologyOutboxRecord {
  readonly envelope: OntologyMaterializationEvent
  readonly availableAt: string
  readonly attempts: number
  readonly leaseId: string | null
  readonly leaseExpiresAt: string | null
  readonly publishedAt: string | null
  readonly lastError: string | null
  readonly createdAt: string
}

export interface ClaimOntologyOutboxInput {
  readonly projectId: string
  readonly now: string
  readonly limit: number
  readonly leaseId: string
  readonly leaseExpiresAt: string
}

export interface ClaimedOntologyOutboxRow extends OntologyOutboxRecord {
  readonly leaseId: string
  readonly leaseExpiresAt: string
}

export interface CompleteOntologyOutboxLeaseInput {
  readonly projectId: string
  readonly ids: readonly string[]
  readonly leaseId: string
  readonly publishedAt: string
}

export interface RescheduleOntologyOutboxLeaseInput {
  readonly projectId: string
  readonly ids: readonly string[]
  readonly leaseId: string
  readonly availableAt: string
  readonly error: string
}

export interface PurgePublishedOntologyOutboxInput {
  readonly projectId: string
  readonly publishedBefore: string
  readonly limit: number
}

export interface OntologyOutboxStorage {
  /** Claims in the parent-spec `(createdAt, eventId)` order. */
  claim(input: ClaimOntologyOutboxInput): Promise<readonly ClaimedOntologyOutboxRow[]>
  markPublished(input: CompleteOntologyOutboxLeaseInput): Promise<void>
  reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void>
  purgePublished(input: PurgePublishedOntologyOutboxInput): Promise<number>
}
