import type { JsonValue } from "../../json"
import type {
  EditCommitResult,
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  LinkOverride,
  ObjectOverride,
  OntologyLinkRef,
  OntologyObjectRef,
  PinnedDatasetVersion,
  ProjectionCommitResult,
  ProjectionExecution,
  ProjectionSourceRef,
  TelemetryCommitResult,
  TelemetrySeriesRef,
} from "../../materialization/model"
import type { OntologyCommitRecord, OntologyCommitWrite } from "./commits"
import type { OntologyMaterializationEventDraft, OntologyOutboxWrite } from "./outbox"
import type { StoredSourceLinkAssertion, StoredSourceObjectAssertion } from "./sources"

export interface StoredObjectOverride {
  readonly ref: OntologyObjectRef
  readonly value: ObjectOverride
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface StoredLinkOverride {
  readonly ref: OntologyLinkRef
  readonly value: LinkOverride
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface StoredTelemetryPoint {
  readonly series: TelemetrySeriesRef
  readonly value: JsonValue
  readonly unit?: string
  readonly at: string
  readonly lastCommitId: string
}

export interface ExpectedTimeseriesPointRevision {
  readonly series: TelemetrySeriesRef
  readonly at: string
  readonly lastCommitId: string | null
}

export interface MaterializationObjectState {
  readonly ref: OntologyObjectRef
  readonly source: StoredSourceObjectAssertion | null
  readonly override: StoredObjectOverride | null
  readonly effective: EffectiveObjectSnapshot | null
  readonly latestTelemetry: readonly StoredTelemetryPoint[]
}

export interface MaterializationLinkState {
  readonly ref: OntologyLinkRef
  readonly source: StoredSourceLinkAssertion | null
  readonly override: StoredLinkOverride | null
  readonly effective: EffectiveLinkSnapshot | null
}

export interface MaterializationLinkScopeState {
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly effectiveCount: number
  readonly fingerprint: string
}

export interface MaterializationStatePage {
  readonly objects: readonly MaterializationObjectState[]
  readonly links: readonly MaterializationLinkState[]
  readonly linkScopes: readonly MaterializationLinkScopeState[]
  readonly points: readonly StoredTelemetryPoint[]
}

export interface SourceReplacementObjectState extends Omit<MaterializationObjectState, "source"> {
  readonly candidateSource: StoredSourceObjectAssertion | null
}

export interface SourceReplacementLinkState extends Omit<MaterializationLinkState, "source"> {
  readonly candidateSource: StoredSourceLinkAssertion | null
  /** False only for an unchanged existing member included to validate a complete link scope. */
  readonly diffRequired: boolean
}

export interface SourceReplacementStatePage {
  readonly objects: readonly SourceReplacementObjectState[]
  readonly links: readonly SourceReplacementLinkState[]
}

export interface MaterializationStateRequestChunk {
  readonly objects: readonly OntologyObjectRef[]
  readonly links: readonly OntologyLinkRef[]
  readonly linkScopes: readonly {
    readonly source: OntologyObjectRef
    readonly linkId: string
  }[]
  /** Provider work request for every effective link touching these objects in either direction. */
  readonly incidentObjects: readonly OntologyObjectRef[]
  readonly points: readonly {
    readonly series: TelemetrySeriesRef
    readonly at: string
  }[]
}

/**
 * Provider-local opaque handle valid only for its creating transaction until commit or rollback.
 * Providers own the token and validate its identity/liveness (for example, through a WeakMap).
 */
export interface MaterializationSession {
  readonly providerToken: object
}

export interface ExpectedSourceRevision {
  readonly source: ProjectionSourceRef
  readonly activeMaterializationId: string | null
  readonly lastCommitId: string | null
}

export interface MaterializationCasState {
  readonly sources: readonly ExpectedSourceRevision[]
  readonly objects: readonly ExpectedObjectRevision[]
  readonly links: readonly ExpectedLinkRevision[]
  readonly linkScopes: readonly ExpectedLinkScopeRevision[]
  readonly points: readonly ExpectedTimeseriesPointRevision[]
}

export interface MaterializationPlanHeader {
  /**
   * Core must fence Action/projection execution through the matching run facade on this same
   * transaction before opening the exact-plan session. Replacement activation and telemetry
   * checkpoint writes recheck the token before commit.
   */
  readonly commit: OntologyCommitWrite
  readonly expected: MaterializationCasState
}

export interface ExactObjectOverrideWrite {
  readonly ref: OntologyObjectRef
  readonly value: ObjectOverride
  readonly expectedLastCommitId: string | null
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface ExactLinkOverrideWrite {
  readonly ref: OntologyLinkRef
  readonly value: LinkOverride
  readonly expectedLastCommitId: string | null
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface ExactObjectOverrideDelete {
  readonly ref: OntologyObjectRef
  readonly expectedLastCommitId: string
}

export interface ExactLinkOverrideDelete {
  readonly ref: OntologyLinkRef
  readonly expectedLastCommitId: string
}

export interface ExactOverrideWrites {
  readonly objectUpserts: readonly ExactObjectOverrideWrite[]
  readonly objectDeletes: readonly ExactObjectOverrideDelete[]
  readonly linkUpserts: readonly ExactLinkOverrideWrite[]
  readonly linkDeletes: readonly ExactLinkOverrideDelete[]
}

export interface ExactEffectiveObjectWrite {
  readonly row: EffectiveObjectSnapshot
  readonly expected: ExpectedObjectRevision
}

export interface ExactEffectiveLinkWrite {
  readonly row: EffectiveLinkSnapshot
  readonly expected: ExpectedLinkRevision
}

export interface ExactEffectiveObjectDelete {
  readonly ref: OntologyObjectRef
  readonly expected: Extract<ExpectedObjectRevision, { readonly exists: true }>
}

export interface ExactEffectiveLinkDelete {
  readonly ref: OntologyLinkRef
  readonly expected: Extract<ExpectedLinkRevision, { readonly exists: true }>
}

export interface ExactEffectiveWrites {
  readonly objectUpserts: readonly ExactEffectiveObjectWrite[]
  readonly objectDeletes: readonly ExactEffectiveObjectDelete[]
  readonly linkUpserts: readonly ExactEffectiveLinkWrite[]
  readonly linkDeletes: readonly ExactEffectiveLinkDelete[]
}

export interface ExactTimeseriesPointWrite {
  readonly point: StoredTelemetryPoint
  readonly expected: ExpectedTimeseriesPointRevision
}

export interface ExactTimeseriesWrites {
  readonly pointUpserts: readonly ExactTimeseriesPointWrite[]
}

export interface MaterializationPlanChunk {
  readonly overrides: ExactOverrideWrites
  readonly effective: ExactEffectiveWrites
  readonly timeseries: ExactTimeseriesWrites
  readonly outbox: readonly OntologyOutboxWrite[]
}

export interface SourceActivationWrite {
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly execution: ProjectionExecution
  readonly projectionKind: "object" | "link"
  readonly protocol: "replacement"
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
  readonly expected: ExpectedSourceRevision
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface MaterializationPlanFinalization {
  readonly sourceActivations: readonly SourceActivationWrite[]
  readonly result: EditCommitResult | ProjectionCommitResult | TelemetryCommitResult
}

export interface ApplyMaterializationChunkInput {
  readonly session: MaterializationSession
  readonly chunk: MaterializationPlanChunk
}

export interface FinalizeMaterializationInput {
  readonly session: MaterializationSession
  readonly finalization: MaterializationPlanFinalization
}

export interface ApplyMaterializationResult {
  readonly commit: OntologyCommitRecord
}

export interface StreamMaterializationStateInput {
  readonly session: MaterializationSession
  readonly requests: AsyncIterable<MaterializationStateRequestChunk>
  readonly pageRows: number
}

export interface StreamSourceReplacementStateInput {
  readonly session: MaterializationSession
  readonly source: ProjectionSourceRef
  readonly candidateMaterializationId: string
  readonly entityKind: "object" | "link"
  readonly pageRows: number
}

export type MaterializationWorkEntityKind = "object" | "link" | "point"

export interface MaterializationClassificationWorkRecord {
  readonly kind: "classification"
  readonly recordKey: string
  readonly entityKind: MaterializationWorkEntityKind
  readonly identityKey: string
}

export interface MaterializationObjectExistenceWorkRecord {
  readonly kind: "object-existence"
  readonly recordKey: string
  readonly ref: OntologyObjectRef
  readonly exists: boolean
}

export interface MaterializationIncidentObjectWorkRecord {
  readonly kind: "incident-object"
  readonly recordKey: string
  readonly ref: OntologyObjectRef
}

export interface MaterializationCardinalityOccupantWorkRecord {
  readonly kind: "cardinality"
  readonly recordKey: string
  readonly scopeSortKey: string
  readonly linkSortKey: string
  readonly ref: OntologyLinkRef
  readonly occupied: boolean
}

export type MaterializationPlanWorkItem =
  | { readonly kind: "object-override-upsert"; readonly value: ExactObjectOverrideWrite }
  | { readonly kind: "object-override-delete"; readonly value: ExactObjectOverrideDelete }
  | { readonly kind: "link-override-upsert"; readonly value: ExactLinkOverrideWrite }
  | { readonly kind: "link-override-delete"; readonly value: ExactLinkOverrideDelete }
  | { readonly kind: "object-upsert"; readonly value: ExactEffectiveObjectWrite }
  | { readonly kind: "object-delete"; readonly value: ExactEffectiveObjectDelete }
  | { readonly kind: "link-upsert"; readonly value: ExactEffectiveLinkWrite }
  | { readonly kind: "link-delete"; readonly value: ExactEffectiveLinkDelete }
  | { readonly kind: "point-upsert"; readonly value: ExactTimeseriesPointWrite }

/**
 * Safe physical phases shared by the core planner and provider validation through
 * {@link materializationApplyPhase}.
 */
export type MaterializationApplyPhase = 0 | 1 | 2 | 3 | 4 | 5

export interface MaterializationPlanWorkRecord {
  readonly kind: "plan"
  readonly recordKey: string
  readonly applyPhase: MaterializationApplyPhase
  readonly sortKey: string
  readonly item: MaterializationPlanWorkItem
}

/**
 * Canonical physical apply phase for a plan work item kind. The application-layer work planner and
 * the provider's order validation both derive ordering from this single source so the two can never
 * drift apart. Kept in the neutral storage contract because storage must not import the materializer.
 */
export function materializationApplyPhase(
  kind: MaterializationPlanWorkItem["kind"]
): MaterializationApplyPhase {
  switch (kind) {
    case "object-override-upsert":
    case "object-override-delete":
    case "link-override-upsert":
    case "link-override-delete":
      return 0
    case "point-upsert":
      return 1
    case "link-delete":
      return 2
    case "object-delete":
      return 3
    case "object-upsert":
      return 4
    case "link-upsert":
      return 5
  }
}

export interface MaterializationEventWorkRecord {
  readonly kind: "event"
  readonly recordKey: string
  readonly eventKindRank: number
  readonly sortKey: string
  readonly draft: OntologyMaterializationEventDraft
}

export type MaterializationWorkRecord =
  | MaterializationClassificationWorkRecord
  | MaterializationObjectExistenceWorkRecord
  | MaterializationIncidentObjectWorkRecord
  | MaterializationCardinalityOccupantWorkRecord
  | MaterializationPlanWorkRecord
  | MaterializationEventWorkRecord

export interface StageMaterializationWorkInput {
  readonly session: MaterializationSession
  /** Insert-only and batch-atomic. Staging closes when any work lane starts streaming. */
  readonly records: readonly MaterializationWorkRecord[]
}

export interface StreamMaterializationWorkInput {
  readonly session: MaterializationSession
  /** Canonical provider-owned lanes: physical writes, cardinality occupants, then event drafts. */
  readonly order: "apply" | "cardinality" | "event"
  readonly pageRows: number
}

export interface MaterializationWorkPage {
  readonly records: readonly (
    | MaterializationPlanWorkRecord
    | MaterializationCardinalityOccupantWorkRecord
    | MaterializationEventWorkRecord
  )[]
}

export interface ReadMaterializationObjectExistenceInput {
  readonly session: MaterializationSession
  readonly refs: readonly OntologyObjectRef[]
}

export interface MaterializationObjectExistence {
  readonly ref: OntologyObjectRef
  readonly exists: boolean
}

export interface OntologyMaterializationStorage {
  begin(input: MaterializationPlanHeader): Promise<MaterializationSession>
  streamState(input: StreamMaterializationStateInput): AsyncIterable<MaterializationStatePage>
  streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage>
  stageWork(input: StageMaterializationWorkInput): Promise<void>
  streamWork(input: StreamMaterializationWorkInput): AsyncIterable<MaterializationWorkPage>
  readObjectExistence(
    input: ReadMaterializationObjectExistenceInput
  ): Promise<readonly MaterializationObjectExistence[]>
  applyChunk(input: ApplyMaterializationChunkInput): Promise<void>
  /**
   * Finalizes ontology-owned state only. Execution checkpoints remain owned by their run stores
   * and are coordinated by the Materializer through the enclosing Storage transaction.
   */
  finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult>
}
