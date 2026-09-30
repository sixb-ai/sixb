import type {
  PinnedDatasetVersion,
  ProjectionEntityRef,
  ProjectionExecution,
  ProjectionSourceAssertion,
  ProjectionSourceBase,
  ProjectionSourceRef,
} from "../../materialization/model"

export type OntologySourceMaterializationStatus =
  | "staging"
  | "ready"
  | "active"
  | "superseded"
  | "abandoned"

/**
 * One explicit, durable materialization of a projection source.
 *
 * Staging/ready records retain their execution token so every write can be fenced. Active and
 * terminal records clear it: queue execution ownership is transient and is not source authority.
 */
export interface OntologySourceRecord {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly projectionRunId: string
  readonly projectionKind: "object" | "link"
  readonly protocol: "replacement"
  readonly status: OntologySourceMaterializationStatus
  readonly executionToken: string | null
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
  readonly base?: ProjectionSourceBase
  /** Staged roots, including explicit deletions for a delta; null until sealed by markReady. */
  readonly rootCount: number | null
  /** Null until staging is sealed by markReady; zero explicitly represents an empty output. */
  readonly assertionCount: number | null
  readonly createdAt: string
  readonly readyAt: string | null
  readonly activatedAt: string | null
  readonly terminalAt: string | null
  readonly lastCommitId: string | null
  readonly updatedAt: string
}

export interface StoredSourceObjectAssertion {
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly root: ProjectionEntityRef
  readonly assertion: Extract<ProjectionSourceAssertion, { readonly kind: "object" }>
  readonly stagingOrdinal: number
}

export interface StoredSourceLinkAssertion {
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly root: ProjectionEntityRef
  readonly assertion: Extract<ProjectionSourceAssertion, { readonly kind: "link" }>
  readonly stagingOrdinal: number
}

export type StoredSourceAssertion = StoredSourceObjectAssertion | StoredSourceLinkAssertion

export interface GetActiveOntologySourceInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
}

export interface BeginSourceMaterializationInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly execution: ProjectionExecution
  readonly projectionKind: "object" | "link"
  readonly protocol: "replacement"
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
  readonly base?: ProjectionSourceBase
  readonly createdAt: string
}

/** One normalized assertion staged under an existing source materialization manifest. */
export interface StageSourceAssertion {
  readonly root: ProjectionEntityRef
  readonly assertion: ProjectionSourceAssertion
  readonly stagingOrdinal: number
}

export interface StageSourceRowsInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly execution: ProjectionExecution
  readonly rows: readonly StageSourceAssertion[]
  /** Explicit root removals, allowed only for a candidate with a pinned base. */
  readonly deletions?: readonly StageSourceRoot[]
}

export interface StageSourceRoot {
  readonly root: ProjectionEntityRef
  readonly stagingOrdinal: number
}

export interface StageSourceRowsResult {
  readonly inserted: number
  readonly unchanged: number
}

export interface MarkSourceMaterializationReadyInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly execution: ProjectionExecution
  readonly rootCount: number
  readonly assertionCount: number
  readonly readyAt: string
}

interface BaseAbandonSourceMaterializationInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly execution: ProjectionExecution
  readonly abandonedAt: string
}

/** Abandon the current execution's exact candidate, e.g. an adopted one whose delta base moved. */
export interface AbandonSourceMaterializationCandidateInput
  extends BaseAbandonSourceMaterializationInput {
  readonly kind: "candidate"
  readonly materializationId: string
}

/**
 * Release whatever candidate a run still holds, whichever execution staged it. Called in the same
 * transaction as the run's terminal transition, so no candidate outlives its run.
 */
export interface AbandonRunSourceMaterializationInput
  extends BaseAbandonSourceMaterializationInput {
  readonly kind: "run"
}

export type AbandonSourceMaterializationInput =
  | AbandonSourceMaterializationCandidateInput
  | AbandonRunSourceMaterializationInput

export interface AdoptSourceMaterializationInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly execution: ProjectionExecution
  readonly adoptedAt: string
}

export interface AdoptedSourceMaterialization {
  readonly record: OntologySourceRecord
  /**
   * Where staging resumes. Every root before this ordinal is complete; the root at it may be
   * partial and is staged again, which staging accepts for identical rows. Equals the root count
   * once the candidate is ready.
   */
  readonly resumeStagingOrdinal: number
}

export interface CleanupTerminalSourceMaterializationsInput {
  readonly projectId: string
  /** Exclusive cutoff for retired roots in superseded manifests, and for empty ones. */
  readonly terminalBefore: string
  /** Maximum total assertion, root-reference, and manifest deletions performed by one call. */
  readonly limit: number
}

export interface CleanupTerminalSourceMaterializationsResult {
  /** Assertion rows and root references deleted. */
  readonly rowsDeleted: number
  readonly materializationsDeleted: number
}

export interface PurgeAbandonedSourceMaterializationsInput {
  readonly projectId: string
  /** Maximum total assertion, root-reference, and manifest deletions performed by one call. */
  readonly limit: number
}

export interface SummarizeTerminalSourceMaterializationsInput {
  readonly projectId: string
}

export interface TerminalSourceMaterializationSummary {
  readonly count: number
  readonly oldestTerminalAt: string | null
}

export interface AssertSourceMaterializationExecutionInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly execution: ProjectionExecution
  /** Full immutable source identity, required when a candidate manifest is first created. */
  readonly identity?: Pick<
    BeginSourceMaterializationInput,
    | "projectionKind"
    | "protocol"
    | "datasetVersion"
    | "projectionRevision"
    | "ownershipHash"
    | "ontologyRevision"
  >
}

export type AssertSourceMaterializationExecution = (
  input: AssertSourceMaterializationExecutionInput
) => Promise<void> | void

export interface OntologySourceStorage {
  beginMaterialization(input: BeginSourceMaterializationInput): Promise<OntologySourceRecord>
  stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult>
  markReady(input: MarkSourceMaterializationReadyInput): Promise<OntologySourceRecord>
  getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null>
  /** Hands a redelivered run's candidate to its current execution; null when it has none. */
  adopt(input: AdoptSourceMaterializationInput): Promise<AdoptedSourceMaterialization | null>
  abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  abandon(input: AbandonRunSourceMaterializationInput): Promise<OntologySourceRecord | null>
  /** Retired roots of superseded manifests, after their retention. */
  cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult>
  /**
   * Abandoned candidates, whole and oldest first. Nothing reads an abandoned candidate, so it has
   * no retention; deleting one manifest at a time keeps each delete on the source-version index.
   */
  purgeAbandoned(
    input: PurgeAbandonedSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult>
  summarizeTerminal(
    input: SummarizeTerminalSourceMaterializationsInput
  ): Promise<TerminalSourceMaterializationSummary>
}
