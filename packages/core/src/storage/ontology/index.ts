import type { OntologyCommitStorage } from "./commits"
import type { OntologyMaterializationStorage } from "./materializations"
import type { OntologyOutboxStorage } from "./outbox"
import type { OntologyReplacementPlanStorage } from "./replacement-plans"
import type { OntologySourceStorage } from "./sources"
import type { OntologyVectorIndexingStorage } from "./vector-indexing"
import type { OntologyVectorStorage } from "./vectors"

export type { ProjectionExecution } from "../../materialization/model"
export type {
  EditOntologyCommitIntent,
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  GetOntologyCommitByOriginInput,
  ListOntologyCommitsInput,
  ListOntologyCommitsResult,
  OntologyCommitOriginSelector,
  OntologyCommitRecord,
  OntologyCommitRunSelector,
  OntologyCommitStorage,
  OntologyCommitWrite,
  ProjectionOntologyCommitIntent,
  TelemetryOntologyCommitIntent,
} from "./commits"
export type {
  AppliedMaterialization,
  ApplyMaterializationInput,
  ApplyMaterializationResult,
  ExactEffectiveLinkDelete,
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectDelete,
  ExactEffectiveObjectWrite,
  ExactLinkOverrideDelete,
  ExactLinkOverrideWrite,
  ExactLinkSlotOverrideDelete,
  ExactLinkSlotOverrideWrite,
  ExactObjectOverrideDelete,
  ExactObjectOverrideWrite,
  ExactTimeseriesPointWrite,
  ExpectedSourceRevision,
  ExpectedTimeseriesPointRevision,
  FinalizeMaterializationInput,
  MaterializationApplyPhase,
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationCasState,
  MaterializationClassificationWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationIncidentObjectWorkRecord,
  MaterializationLinkScopeRevision,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectExistence,
  MaterializationObjectExistenceWorkRecord,
  MaterializationObjectState,
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  MaterializationPlanWorkItem,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationStateRequestChunk,
  MaterializationVectorChange,
  MaterializationVectorChangePage,
  MaterializationWorkEntityKind,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  SourceActivationWrite,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  StageMaterializationWorkInput,
  StoredLinkOverride,
  StoredLinkSlotOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamMaterializationVectorChangesInput,
} from "./materializations"
export type {
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CompleteOntologyOutboxLeaseInput,
  OntologyMaterializationEvent,
  OntologyMaterializationEventDraft,
  OntologyOutboxFailure,
  OntologyOutboxFailureCode,
  OntologyOutboxRecord,
  OntologyOutboxStorage,
  OntologyOutboxSummary,
  PurgePublishedOntologyOutboxInput,
  RescheduleOntologyOutboxLeaseInput,
  SummarizeOntologyOutboxInput,
} from "./outbox"
export { ONTOLOGY_OUTBOX_FAILURE_CODES } from "./outbox"
export type {
  OntologyReplacementPlanStorage,
  OpenedReplacementPlan,
  OpenReplacementPlanInput,
  PlannedReplacementIdentity,
  PurgeReplacementPlansInput,
  ReplacementPlanRef,
  ReplacementPlanStatePage,
  ReplacementPlanStatus,
  StageReplacementPlanInput,
  StreamReplacementPlanStateInput,
} from "./replacement-plans"
export type {
  AbandonRunSourceMaterializationInput,
  AbandonSourceMaterializationCandidateInput,
  AbandonSourceMaterializationInput,
  AdoptedSourceMaterialization,
  AdoptSourceMaterializationInput,
  AssertSourceMaterializationExecution,
  AssertSourceMaterializationExecutionInput,
  BeginSourceMaterializationInput,
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  GetActiveOntologySourceInput,
  MarkSourceMaterializationReadyInput,
  OntologySourceMaterializationStatus,
  OntologySourceRecord,
  OntologySourceStorage,
  PurgeAbandonedSourceMaterializationsInput,
  StageSourceAssertion,
  StageSourceRoot,
  StageSourceRowsInput,
  StageSourceRowsResult,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
  SummarizeTerminalSourceMaterializationsInput,
  TerminalSourceMaterializationSummary,
} from "./sources"

export type { ObjectVectorState, OntologyVectorStorage, StoredObjectVector } from "./vectors"

export interface OntologyStorage {
  readonly vectorIndexing?: OntologyVectorIndexingStorage
  readonly vectors?: OntologyVectorStorage
  readonly commits: OntologyCommitStorage
  readonly sources: OntologySourceStorage
  readonly materializations: OntologyMaterializationStorage
  readonly replacementPlans: OntologyReplacementPlanStorage
  readonly outbox: OntologyOutboxStorage
}

export type {
  OntologyVectorIndexingStorage,
  VectorIndexingFailureCode,
  VectorIndexingRequest,
  VectorIndexingUpdate,
  VectorIndexingWork,
} from "./vector-indexing"
