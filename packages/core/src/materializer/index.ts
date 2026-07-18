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
export type { MaterializationConflictKind } from "./errors"
export {
  isMaterializationConflictError,
  MaterializationConflictError,
  MaterializationValidationError,
} from "./errors"
export type { FixedCommitIdentity, OntologyMaterializationEventKind } from "./identity"
export {
  createActionIdempotencyKey,
  createCommitId,
  createEventId,
  createFixedCommitIdentity,
  createLinkScopeFingerprint,
  createProjectionGenerationId,
  createProjectionIdempotencyKey,
  createProjectionTelemetryIdempotencyKey,
  createRequestHash,
  createRuntimeIdempotencyKey,
  createRuntimeTelemetryIdempotencyKey,
  materializationEventKindOrdinal,
  ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER,
  sha256Canonical,
} from "./identity"
export {
  canonicalJson,
  normalizeJsonProperties,
  normalizeOntologyEditCommit,
  normalizeProjectionSourceEntry,
  normalizeTelemetryAppend,
} from "./normalize"
export {
  compareLinkRefs,
  compareObjectRefs,
  linkRefKey,
  normalizeLinkRef,
  normalizeObjectRef,
  objectRefKey,
  projectionEntityKey,
  telemetryPointKey,
  telemetrySeriesKey,
} from "./refs"
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
  OntologyMaterializer,
  OntologyObjectRef,
  OntologyOperationOutcome,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionEntityRef,
  ProjectionOwnership,
  ProjectionSourceAssertion,
  ProjectionSourceEntry,
  ProjectionSourceRef,
  ProjectionSourceReplacement,
  ResolvedProjection,
  TelemetryAppend,
  TelemetryCommitResult,
  TelemetryPointWrite,
  TelemetrySeriesRef,
} from "./types"
