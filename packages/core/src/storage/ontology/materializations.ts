import type { JsonValue } from "../../json"
import type {
  EditCommitResult,
  EffectiveChangeCounts,
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
  ProjectionSourceRef,
  TelemetryCommitResult,
  TelemetrySeriesRef,
} from "../../materializer/types"
import type { OntologyCommitRecord, OntologyCommitWrite } from "./commits"
import type { OntologyOutboxWrite } from "./outbox"
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
  readonly fingerprint: string
  readonly links: readonly EffectiveLinkSnapshot[]
}

export interface MaterializationStatePage {
  readonly objects: readonly MaterializationObjectState[]
  readonly links: readonly MaterializationLinkState[]
  readonly linkScopes: readonly MaterializationLinkScopeState[]
  readonly points: readonly StoredTelemetryPoint[]
}

export interface SourceReplacementObjectState extends Omit<MaterializationObjectState, "source"> {
  readonly previousSource: StoredSourceObjectAssertion | null
  readonly candidateSource: StoredSourceObjectAssertion | null
}

export interface SourceReplacementLinkState extends Omit<MaterializationLinkState, "source"> {
  readonly previousSource: StoredSourceLinkAssertion | null
  readonly candidateSource: StoredSourceLinkAssertion | null
}

export interface SourceReplacementStatePage {
  readonly objects: readonly SourceReplacementObjectState[]
  readonly links: readonly SourceReplacementLinkState[]
  readonly linkScopes: readonly MaterializationLinkScopeState[]
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
 * Provider-local opaque handle valid only for its enclosing transaction.
 * Providers own the token and validate its identity/liveness (for example, through a WeakMap).
 */
export interface MaterializationSession {
  readonly providerToken: object
}

export interface ExpectedSourceRevision {
  readonly source: ProjectionSourceRef
  readonly activeGenerationId: string | null
  readonly lastCommitId: string | null
}

export interface MaterializationCasState {
  readonly ontologyRevision: string
  readonly sources: readonly ExpectedSourceRevision[]
  readonly objects: readonly ExpectedObjectRevision[]
  readonly links: readonly ExpectedLinkRevision[]
  readonly linkScopes: readonly ExpectedLinkScopeRevision[]
  readonly points: readonly ExpectedTimeseriesPointRevision[]
}

export interface MaterializationPlanHeader {
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
  readonly generationId: string
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
  readonly expected: ExpectedSourceRevision
  readonly lastCommitId: string
  readonly updatedAt: string
}

export type MaterializationRunBookkeeping =
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly runId: string
      readonly commitId: string
    }
  | {
      readonly kind: "projection"
      readonly protocol: "replacement"
      readonly projectionId: string
      readonly runId: string
      readonly datasetVersion: PinnedDatasetVersion
      readonly projectionRevision: string
      readonly commitId: string
      readonly stagedRootCount: number
      readonly stagedAssertionCount: number
      readonly counts: EffectiveChangeCounts
    }
  | {
      readonly kind: "projection"
      readonly protocol: "telemetry"
      readonly projectionId: string
      readonly runId: string
      readonly datasetVersion: PinnedDatasetVersion
      readonly projectionRevision: string
      readonly commitId: string
      readonly batchOrdinal: number
      readonly batchPointCount: number
      readonly pointsCreated: number
      readonly pointsUpdated: number
      readonly pointsUnchanged: number
      readonly latestObjectsChanged: number
    }

export interface MaterializationPlanFinalization {
  readonly sourceActivations: readonly SourceActivationWrite[]
  readonly result: EditCommitResult | ProjectionCommitResult | TelemetryCommitResult
  readonly bookkeeping?: MaterializationRunBookkeeping
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
  readonly candidateGenerationId: string
  readonly pageRows: number
}

export interface OntologyMaterializationStorage {
  begin(input: MaterializationPlanHeader): Promise<MaterializationSession>
  streamState(input: StreamMaterializationStateInput): AsyncIterable<MaterializationStatePage>
  streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage>
  applyChunk(input: ApplyMaterializationChunkInput): Promise<void>
  finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult>
}
