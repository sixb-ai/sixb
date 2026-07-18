import type {
  PinnedDatasetVersion,
  ProjectionEntityRef,
  ProjectionSourceAssertion,
  ProjectionSourceRef,
} from "../../materializer/types"

export interface OntologySourceRecord {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly activeGenerationId: string
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
  readonly lastCommitId: string
  readonly updatedAt: string
}

export interface StoredSourceObjectAssertion {
  readonly source: ProjectionSourceRef
  readonly generationId: string
  readonly root: ProjectionEntityRef
  readonly assertion: Extract<ProjectionSourceAssertion, { readonly kind: "object" }>
  readonly stagingOrdinal: number
}

export interface StoredSourceLinkAssertion {
  readonly source: ProjectionSourceRef
  readonly generationId: string
  readonly root: ProjectionEntityRef
  readonly assertion: Extract<ProjectionSourceAssertion, { readonly kind: "link" }>
  readonly stagingOrdinal: number
}

export type StoredSourceAssertion = StoredSourceObjectAssertion | StoredSourceLinkAssertion

export interface GetActiveOntologySourceInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
}

/** One normalized assertion staged under the source and generation supplied by the batch. */
export interface StageSourceAssertion {
  readonly root: ProjectionEntityRef
  readonly assertion: ProjectionSourceAssertion
  readonly stagingOrdinal: number
}

export interface StageSourceRowsInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly generationId: string
  readonly stagedAt: string
  readonly rows: readonly StageSourceAssertion[]
}

export interface StageSourceRowsResult {
  readonly inserted: number
  readonly unchanged: number
}

export interface DiscardSourceGenerationInput {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly generationId: string
}

export interface CleanupInactiveSourceGenerationsInput {
  readonly projectId: string
  readonly olderThan: string
  readonly limit: number
}

export interface OntologySourceStorage {
  getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null>
  stage(input: StageSourceRowsInput): Promise<StageSourceRowsResult>
  discard(input: DiscardSourceGenerationInput): Promise<void>
  cleanupInactive(input: CleanupInactiveSourceGenerationsInput): Promise<number>
}
