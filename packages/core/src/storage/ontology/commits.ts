import type { EventActor } from "../../events/envelope"
import type {
  EditCommitResult,
  OntologyMaterializationOrigin,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionSourceRef,
  TelemetryCommitResult,
} from "../../materialization/model"

export interface GetOntologyCommitByIdempotencyKeyInput {
  readonly projectId: string
  readonly idempotencyKey: string
}

export interface GetOntologyCommitByIdInput {
  readonly projectId: string
  readonly id: string
}

export type OntologyCommitOriginSelector =
  | { readonly kind: "action"; readonly actionRunId: string }
  | { readonly kind: "projection"; readonly projectionRunId: string }
  | {
      readonly kind: "telemetry"
      readonly projectionRunId: string
      readonly batchOrdinal: number
    }

export interface GetOntologyCommitByOriginInput {
  readonly projectId: string
  readonly origin: OntologyCommitOriginSelector
}

export type OntologyCommitRunSelector =
  | { readonly kind: "action"; readonly id: string }
  | { readonly kind: "projection"; readonly id: string }

export interface ListOntologyCommitsInput {
  readonly projectId: string
  readonly run?: OntologyCommitRunSelector
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListOntologyCommitsResult {
  readonly commits: readonly OntologyCommitRecord[]
  readonly total: number
  readonly hasMore: boolean
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

interface TelemetryOntologyCommitIntentBase {
  readonly kind: "telemetry"
  /** Canonical unique points that enter semantic materialization. */
  readonly pointCount: number
  /** Caller-supplied points before equal-duplicate normalization. */
  readonly inputPointCount: number
}

export type TelemetryOntologyCommitIntent =
  | (TelemetryOntologyCommitIntentBase & {
      readonly source: { readonly kind: "runtime" }
    })
  | (TelemetryOntologyCommitIntentBase & {
      readonly source: {
        readonly kind: "projection"
        readonly projection: ProjectionSourceRef
        readonly datasetVersion: PinnedDatasetVersion
        readonly batchOrdinal: number
        readonly sourceRowCount: number
        readonly sourceRowsSkipped: number
        readonly inputExhausted: boolean
      }
    })

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
  /** Exact authoritative lookup used by Action/projection lifecycle coordination. */
  getByOrigin(input: GetOntologyCommitByOriginInput): Promise<OntologyCommitRecord | null>
  /** Reads authoritative commit history, optionally correlated to an Action or projection run. */
  list(input: ListOntologyCommitsInput): Promise<ListOntologyCommitsResult>
}
