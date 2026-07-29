/**
 * Provider-neutral ontology materialization contracts.
 *
 * @internal Repository packages only. Application orchestration belongs to `materializer`; storage
 * adapters may depend on this module without depending on that application layer.
 */

export {
  assertPinnedDatasetWatermark,
  comparePinnedDatasetWatermarks,
} from "./dataset-watermark"
export type { MaterializationConflictKind } from "./errors"
export {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationConflictError,
  MaterializationObjectNotFoundError,
  MaterializationValidationError,
} from "./errors"
export type { OntologyMaterializationEvent, OntologyMaterializationEventDraft } from "./events"
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
} from "./model"
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
} from "./refs"
