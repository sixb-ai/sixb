import type { OntologyMaterializationEvent } from "../../materialization/events"

export type {
  OntologyMaterializationEvent,
  OntologyMaterializationEventDraft,
} from "../../materialization/events"

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

export interface SummarizeOntologyOutboxInput {
  readonly projectId: string
}

export interface OntologyOutboxSummary {
  readonly pendingCount: number
  readonly oldestPendingAt: string | null
  /** Pending rows that have already been claimed at least once. */
  readonly retryingCount: number
  readonly maxAttempts: number
}

export interface OntologyOutboxStorage {
  /** Selects each claimed batch deterministically; concurrent publishers may complete out of order. */
  claim(input: ClaimOntologyOutboxInput): Promise<readonly ClaimedOntologyOutboxRow[]>
  markPublished(input: CompleteOntologyOutboxLeaseInput): Promise<void>
  reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void>
  purgePublished(input: PurgePublishedOntologyOutboxInput): Promise<number>
  summarize(input: SummarizeOntologyOutboxInput): Promise<OntologyOutboxSummary>
}
