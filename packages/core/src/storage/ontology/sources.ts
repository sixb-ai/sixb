import type {
  PinnedDatasetVersion,
  ProjectionEntityRef,
  ProjectionExecution,
  ProjectionSourceAssertion,
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
  /** Null until staging is sealed by markReady; zero explicitly represents an empty output. */
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

/** Abandon the current execution's exact candidate after ingress or semantic failure. */
export interface AbandonSourceMaterializationCandidateInput
  extends BaseAbandonSourceMaterializationInput {
  readonly kind: "candidate"
  readonly materializationId: string
}

/**
 * Reclaim a logical run after redelivery. The current execution may abandon the prior execution's
 * staging/ready candidate, but never one already owned by its own token.
 */
export interface ReclaimSourceMaterializationInput extends BaseAbandonSourceMaterializationInput {
  readonly kind: "reclaim"
}

export type AbandonSourceMaterializationInput =
  | AbandonSourceMaterializationCandidateInput
  | ReclaimSourceMaterializationInput

export interface CleanupTerminalSourceMaterializationsInput {
  readonly projectId: string
  /** Exclusive cutoff applied only to superseded/abandoned terminalAt. */
  readonly terminalBefore: string
  /** Maximum total child-row plus manifest deletions performed by one call. */
  readonly limit: number
}

export interface CleanupTerminalSourceMaterializationsResult {
  readonly rowsDeleted: number
  readonly materializationsDeleted: number
}

export interface AssertSourceMaterializationExecutionInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly execution: ProjectionExecution
}

export type AssertSourceMaterializationExecution = (
  input: AssertSourceMaterializationExecutionInput
) => Promise<void> | void

export interface OntologySourceStorage {
  beginMaterialization(input: BeginSourceMaterializationInput): Promise<OntologySourceRecord>
  stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult>
  markReady(input: MarkSourceMaterializationReadyInput): Promise<OntologySourceRecord>
  getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null>
  abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  abandon(input: ReclaimSourceMaterializationInput): Promise<OntologySourceRecord | null>
  cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult>
}
