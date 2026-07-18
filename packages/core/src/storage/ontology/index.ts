import type { OntologyCommitStorage } from "./commits"
import type { OntologyMaterializationStorage } from "./materializations"
import type { OntologyOutboxStorage } from "./outbox"
import type { OntologySourceStorage } from "./sources"

export type {
  EditOntologyCommitIntent,
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  OntologyCommitRecord,
  OntologyCommitStorage,
  OntologyCommitWrite,
  ProjectionOntologyCommitIntent,
  TelemetryOntologyCommitIntent,
} from "./commits"
export type {
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  ExactEffectiveLinkDelete,
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectDelete,
  ExactEffectiveObjectWrite,
  ExactEffectiveWrites,
  ExactLinkOverrideDelete,
  ExactLinkOverrideWrite,
  ExactObjectOverrideDelete,
  ExactObjectOverrideWrite,
  ExactOverrideWrites,
  ExactTimeseriesPointWrite,
  ExactTimeseriesWrites,
  ExpectedSourceRevision,
  ExpectedTimeseriesPointRevision,
  FinalizeMaterializationInput,
  MaterializationCasState,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationPlanChunk,
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  MaterializationRunBookkeeping,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationStateRequestChunk,
  OntologyMaterializationStorage,
  SourceActivationWrite,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  SourceReplacementStatePage,
  StoredLinkOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamSourceReplacementStateInput,
} from "./materializations"
export type {
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CompleteOntologyOutboxLeaseInput,
  OntologyMaterializationEvent,
  OntologyOutboxRecord,
  OntologyOutboxStorage,
  OntologyOutboxWrite,
  PurgePublishedOntologyOutboxInput,
  RescheduleOntologyOutboxLeaseInput,
} from "./outbox"
export type {
  CleanupInactiveSourceGenerationsInput,
  DiscardSourceGenerationInput,
  GetActiveOntologySourceInput,
  OntologySourceRecord,
  OntologySourceStorage,
  StageSourceAssertion,
  StageSourceRowsInput,
  StageSourceRowsResult,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "./sources"

export interface OntologyStorage {
  readonly commits: OntologyCommitStorage
  readonly sources: OntologySourceStorage
  readonly materializations: OntologyMaterializationStorage
  readonly outbox: OntologyOutboxStorage
}
