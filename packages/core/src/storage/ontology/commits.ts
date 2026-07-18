import type { EventActor } from "../../events/envelope"
import type {
  EditCommitResult,
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionSourceRef,
  TelemetryCommitResult,
} from "../../materializer/types"

export interface GetOntologyCommitByIdempotencyKeyInput {
  readonly projectId: string
  readonly idempotencyKey: string
}

export interface GetOntologyCommitByIdInput {
  readonly projectId: string
  readonly id: string
}

interface OntologyCommitFields {
  readonly projectId: string
  readonly id: string
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly origin: OntologyMaterializationOrigin
  readonly actor?: EventActor
  readonly ontologyRevision: string
  readonly projectionRevision?: string
  readonly ownershipHash?: string
  readonly committedAt: string
}

export interface EditOntologyCommitIntent {
  readonly kind: "edit"
  readonly mode: "atomic" | "continue"
  readonly operationCount: number
}

export interface ProjectionOntologyCommitIntent {
  readonly kind: "projection"
  readonly source: ProjectionSourceRef
  readonly datasetVersion: PinnedDatasetVersion
}

export interface TelemetryOntologyCommitIntent {
  readonly kind: "telemetry"
  readonly pointCount: number
  readonly batchOrdinal?: number
}

/** Commit metadata and intent supplied before the transaction is finalized. */
export type OntologyCommitWrite =
  | (OntologyCommitFields & { readonly intent: EditOntologyCommitIntent })
  | (OntologyCommitFields & { readonly intent: ProjectionOntologyCommitIntent })
  | (OntologyCommitFields & { readonly intent: TelemetryOntologyCommitIntent })

/** Read-only finalized commit with an intent-correlated authoritative result. */
export type OntologyCommitRecord =
  | (OntologyCommitFields & {
      readonly intent: EditOntologyCommitIntent
      readonly result: EditCommitResult
    })
  | (OntologyCommitFields & {
      readonly intent: ProjectionOntologyCommitIntent
      readonly result: ProjectionCommitResult
    })
  | (OntologyCommitFields & {
      readonly intent: TelemetryOntologyCommitIntent
      readonly result: TelemetryCommitResult
    })

export interface OntologyCommitStorage {
  getByIdempotencyKey(
    input: GetOntologyCommitByIdempotencyKeyInput
  ): Promise<OntologyCommitRecord | null>
  getById(input: GetOntologyCommitByIdInput): Promise<OntologyCommitRecord | null>
}
