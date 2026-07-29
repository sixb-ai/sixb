export {
  assertPinnedDatasetWatermark,
  comparePinnedDatasetWatermarks,
} from "../materialization/dataset-watermark"
export type { MaterializationConflictKind } from "../materialization/errors"
export {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationConflictError,
  MaterializationObjectNotFoundError,
  MaterializationValidationError,
} from "../materialization/errors"
export type {
  BaseCommitResult,
  EditCommitResult,
  EffectiveChangeCounts,
  EffectiveLinkChange,
  EffectiveLinkSnapshot,
  EffectiveObjectChange,
  EffectiveObjectSnapshot,
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  LinkOverride,
  MaterializationItemError,
  ObjectOverride,
  OntologyEditCommit,
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyMaterializationOrigin,
  OntologyMaterializationPropertyChange,
  OntologyMaterializationPropertyChangeMap,
  OntologyObjectRef,
  OntologyOperationOutcome,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionEntityRef,
  ProjectionExecution,
  ProjectionMaterializationIdentity,
  ProjectionProtocolIdentity,
  ProjectionRunFinishInput,
  ProjectionSourceAssertion,
  ProjectionSourceEntry,
  ProjectionSourceRef,
  ProjectionSourceReplacement,
  TelemetryAppend,
  TelemetryCommitResult,
  TelemetryPointWrite,
  TelemetrySeriesRef,
} from "../materialization/model"
export {
  canonicalIdentitySortKey,
  compareLinkRefs,
  compareObjectRefs,
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  normalizeLinkRef,
  normalizeObjectRef,
  objectRefKey,
  objectRefSortKey,
  projectionEntityKey,
  telemetryPointKey,
  telemetryPointSortKey,
  telemetrySeriesKey,
} from "../materialization/refs"
export {
  computeProjectionOwnership,
  validateProjectionOwnership,
} from "../projections/ownership"
export { ProjectionRegistry } from "../projections/registry"
export {
  computeOntologyRevision,
  computeProjectionOwnershipHash,
  computeProjectionRevision,
} from "../projections/revision"
export type { ProjectionOwnership, ResolvedProjection } from "../projections/types"
export type { MaterializerStorage, OntologyMaterializerDependencies } from "./materializer"
export { createOntologyMaterializer, OntologyMaterializer } from "./materializer"
export type {
  CommitIdentity,
  OntologyMaterializationEventKind,
  TimedCommitIdentity,
} from "./shared/identity"
export {
  createActionIdempotencyKey,
  createCommitId,
  createCommitIdentity,
  createEventId,
  createLinkScopeFingerprint,
  createProjectionIdempotencyKey,
  createProjectionMaterializationId,
  createProjectionTelemetryIdempotencyKey,
  createRequestHash,
  createRuntimeIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
  createTimedCommitIdentity,
  materializationEventKindOrdinal,
  ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER,
  sha256Canonical,
  timestampCommitIdentity,
} from "./shared/identity"
export {
  normalizeJsonProperties,
  normalizeOntologyEditCommit,
  normalizeProjectionExecution,
  normalizeProjectionSourceEntry,
  normalizeTelemetryAppend,
} from "./shared/normalize"
