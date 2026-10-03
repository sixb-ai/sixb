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
export type { OntologyMaterializationEventSequence } from "./event-envelopes"
export { eventAttribution, materializationEvent } from "./event-envelopes"
export type {
  OntologyMaterializationEvent,
  OntologyMaterializationEventAttribution,
  OntologyMaterializationEventCommit,
  OntologyMaterializationEventDraft,
} from "./events"
export { createEventId } from "./identity"
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
  LinkSlotOverride,
  MaterializationItemError,
  ObjectOverride,
  OntologyEditCommit,
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyLinkScopeRef,
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
  ProjectionRunTerminalDecision,
  ProjectionSourceAssertion,
  ProjectionSourceBase,
  ProjectionSourceDeletion,
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
export type { ObjectVectorWrite, PreparedObjectVector } from "./vectors"
