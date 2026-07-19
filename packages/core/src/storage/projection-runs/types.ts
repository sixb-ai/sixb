export type ProjectionKind = "object" | "link" | "telemetry"
export type ProjectionRunStatus = "running" | "succeeded" | "failed" | "cancelled"
export type ProjectionMaterializationProtocol = "replacement" | "telemetry"

export interface ProjectionRunDatasetVersion {
  readonly datasetId: string
  readonly versionId: string
  /** Canonical UTC timestamp copied from immutable dataset-version metadata. */
  readonly createdAt: string
}

/** Immutable semantic identity pinned for the lifetime of one logical projection run. */
export interface ProjectionRunMaterializationIdentity {
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly protocol: ProjectionMaterializationProtocol
  readonly datasetVersion: ProjectionRunDatasetVersion
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
}

export interface ProjectionRunCounters {
  readonly rowsProcessed: number
  readonly rowsSkipped: number
  // objectsUpserted, linksUpserted, and telemetryPointsAppended count
  // materialization operations *attempted* during the run, not distinct
  // surviving rows. Operations collapse under last-write-wins upserts (e.g. two
  // rows for the same (object, property, at) telemetry point, or the same
  // object/link key), so these counters can exceed the number of stored rows.
  readonly objectsUpserted: number
  readonly linksUpserted: number
  readonly telemetryPointsAppended: number
  readonly telemetryPointsSkipped: number
  readonly telemetryRowsFailed: number
}

/** Durable materializer outcomes, separate from worker ingress/progress counters. */
export interface ProjectionRunMaterializationCounters {
  readonly stagedRootCount: number
  readonly stagedAssertionCount: number
  readonly objectsCreated: number
  readonly objectsUpdated: number
  readonly objectsDeleted: number
  readonly objectsUnchanged: number
  readonly linksCreated: number
  readonly linksUpdated: number
  readonly linksDeleted: number
  readonly linksUnchanged: number
  readonly telemetryPointsCreated: number
  readonly telemetryPointsUpdated: number
  readonly telemetryPointsUnchanged: number
  readonly latestObjectsChanged: number
}

export function zeroProjectionRunMaterializationCounters(): ProjectionRunMaterializationCounters {
  return {
    stagedRootCount: 0,
    stagedAssertionCount: 0,
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    objectsUnchanged: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    linksUnchanged: 0,
    telemetryPointsCreated: 0,
    telemetryPointsUpdated: 0,
    telemetryPointsUnchanged: 0,
    latestObjectsChanged: 0,
  }
}

// Single source of truth for the counter field names. The Record type forces
// this map to list every ProjectionRunCounters key — omitting one is a compile
// error — so zeroing, merging, and snapshotting can iterate the keys instead of
// re-listing the fields by hand (and silently dropping one).
const counterKeyFlags: Record<keyof ProjectionRunCounters, true> = {
  rowsProcessed: true,
  rowsSkipped: true,
  objectsUpserted: true,
  linksUpserted: true,
  telemetryPointsAppended: true,
  telemetryPointsSkipped: true,
  telemetryRowsFailed: true,
}

export const PROJECTION_COUNTER_KEYS = Object.keys(
  counterKeyFlags
) as readonly (keyof ProjectionRunCounters)[]

/** Builds a fresh counter record with every field zeroed. */
export function zeroProjectionRunCounters(): ProjectionRunCounters {
  const counters = {} as Record<keyof ProjectionRunCounters, number>
  for (const key of PROJECTION_COUNTER_KEYS) {
    counters[key] = 0
  }
  return counters
}

// The object type id(s) the projection materializes are stored on the run so
// visibility can be decided from the run alone (`object.view`), matching how
// action runs carry their subject's object type. Object/telemetry runs set
// `objectTypeId`; link runs set both `sourceObjectTypeId` and
// `targetObjectTypeId`. All are optional so rows written before this column
// existed (and unresolvable projections) stay representable.
export interface ProjectionRunObjectTypes {
  readonly objectTypeId?: string
  readonly sourceObjectTypeId?: string
  readonly targetObjectTypeId?: string
}

/**
 * A run is visible iff every object type it targets passes `canView`. The
 * single rule shared by storage filtering (`canView` = set membership) and
 * authorization (`canView` = `object.view` grant), so the two never drift. A
 * run with no recorded object types (legacy/unresolved) is never visible to a
 * scoped principal.
 */
export function projectionRunObjectTypesVisible(
  run: ProjectionRunObjectTypes,
  canView: (objectTypeId: string) => boolean
): boolean {
  if (run.objectTypeId !== undefined) {
    return canView(run.objectTypeId)
  }

  if (run.sourceObjectTypeId !== undefined && run.targetObjectTypeId !== undefined) {
    return canView(run.sourceObjectTypeId) && canView(run.targetObjectTypeId)
  }

  return false
}

export interface ProjectionRunRecord extends ProjectionRunCounters, ProjectionRunObjectTypes {
  readonly id: string
  readonly projectId: string
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly datasetId: string
  readonly datasetVersionId: string
  readonly status: ProjectionRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly errorMessage?: string
  /** Zero for legacy/non-materializing starts; first materialization claim starts at one. */
  readonly attempt?: number
  readonly materializationProtocol?: ProjectionMaterializationProtocol
  readonly datasetVersionCreatedAt?: string
  readonly ontologyRevision?: string
  readonly projectionRevision?: string
  readonly ownershipHash?: string
  /** Required and immutable for telemetry materialization runs. */
  readonly fixedBatchSize?: number
  /** Replacement runs link exactly one ontology commit. */
  readonly replacementCommitId?: string
  /** Telemetry runs link one commit per ordinal and retain only their latest commit here. */
  readonly lastMaterializationCommitId?: string
  readonly lastCommittedBatchOrdinal?: number
  readonly materializationCommitCount?: number
  readonly materializationCounters?: ProjectionRunMaterializationCounters
}

/** Fully migrated record returned by the strict materialization capability. */
export interface ProjectionMaterializationRunRecord extends ProjectionRunRecord {
  readonly attempt: number
  readonly executionToken: string
  readonly materializationProtocol: ProjectionMaterializationProtocol
  readonly datasetVersionCreatedAt: string
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly materializationCommitCount: number
  readonly materializationCounters: ProjectionRunMaterializationCounters
}

export interface StartProjectionRunInput extends ProjectionRunObjectTypes {
  readonly id: string
  readonly projectId: string
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly datasetId: string
  readonly datasetVersionId: string
  readonly startedAt?: Date
}

export interface StartOrReclaimProjectionMaterializationInput extends ProjectionRunObjectTypes {
  readonly id: string
  readonly projectId: string
  readonly identity: ProjectionRunMaterializationIdentity
  /** Required for telemetry and forbidden for replacement. */
  readonly fixedBatchSize?: number
  readonly startedAt?: Date
}

export interface AssertProjectionMaterializationExecutionInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly identity: ProjectionRunMaterializationIdentity
}

export type UpdateProjectionMaterializationInput = AssertProjectionMaterializationExecutionInput &
  Partial<ProjectionRunCounters>

export type FinishProjectionMaterializationInput = (
  | { readonly status: "succeeded" }
  | { readonly status: "failed" | "cancelled"; readonly errorMessage?: string }
) &
  AssertProjectionMaterializationExecutionInput & {
    readonly finishedAt?: Date
  } & Partial<ProjectionRunCounters>

export interface ProjectionReplacementMaterializationCounts {
  readonly objectsCreated: number
  readonly objectsUpdated: number
  readonly objectsDeleted: number
  readonly objectsUnchanged: number
  readonly linksCreated: number
  readonly linksUpdated: number
  readonly linksDeleted: number
  readonly linksUnchanged: number
}

export interface ProjectionTelemetryMaterializationCounts {
  readonly pointsCreated: number
  readonly pointsUpdated: number
  readonly pointsUnchanged: number
  readonly latestObjectsChanged: number
}

interface ProjectionMaterializationBookkeepingBase {
  readonly kind: "projection"
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly execution: {
    readonly projectionRunId: string
    readonly executionToken: string
  }
  readonly datasetVersion: ProjectionRunDatasetVersion
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly commitId: string
}

export type ProjectionRunMaterializationBookkeeping =
  | (ProjectionMaterializationBookkeepingBase & {
      readonly protocol: "replacement"
      readonly stagedRootCount: number
      readonly stagedAssertionCount: number
      readonly counts: ProjectionReplacementMaterializationCounts
    })
  | (ProjectionMaterializationBookkeepingBase & {
      readonly protocol: "telemetry"
      readonly batchOrdinal: number
      /** Caller-supplied points before equal-duplicate normalization. */
      readonly batchInputCount: number
      /** Canonical unique points classified by the semantic engine. */
      readonly batchPointCount: number
    } & ProjectionTelemetryMaterializationCounts)

interface ProjectionMaterializationReplayBase {
  readonly kind: "projection"
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly execution: {
    readonly projectionRunId: string
    readonly executionToken: string
  }
  readonly datasetVersion: ProjectionRunDatasetVersion
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly commitId: string
}

/**
 * Minimal proof used when the ontology commit already exists. Replay never
 * reconstructs or re-applies counters: it only proves that the exact commit
 * was already linked to the current logical run.
 */
export type ProjectionRunMaterializationReplay =
  | (ProjectionMaterializationReplayBase & {
      readonly protocol: "replacement"
      readonly projectionKind: "object" | "link"
    })
  | (ProjectionMaterializationReplayBase & {
      readonly protocol: "telemetry"
      readonly projectionKind: "telemetry"
      readonly batchOrdinal: number
    })

export type UpdateProjectionRunInput = {
  readonly id: string
  readonly projectId: string
} & Partial<ProjectionRunCounters>

export type FinishProjectionRunInput = (
  | {
      readonly status: "succeeded"
    }
  | {
      readonly status: "failed" | "cancelled"
      readonly errorMessage?: string
    }
) & {
  readonly id: string
  readonly projectId: string
  readonly finishedAt?: Date
} & Partial<ProjectionRunCounters>

export interface ListProjectionRunsInput {
  readonly projectId: string
  readonly projectionId?: string
  readonly projectionKind?: ProjectionKind
  readonly datasetId?: string
  readonly datasetVersionId?: string
  // The viewable object type ids (a principal's `object.view` grants). A run is
  // included only if every object type it targets is in this set. Omit for
  // privileged callers (no filter); an empty set matches no runs.
  readonly objectTypeIds?: readonly string[]
  readonly statuses?: readonly ProjectionRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListProjectionRunsResult {
  readonly runs: readonly ProjectionRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface ListLatestProjectionRunsInput {
  readonly projectId: string
  readonly projectionIds: readonly string[]
}

export interface ListLatestProjectionRunsResult {
  readonly runs: readonly ProjectionRunRecord[]
}

export interface ProjectionRunStorage {
  /** Claim a new logical run or fence its prior execution with a fresh opaque token. */
  startOrReclaimMaterialization?(
    input: StartOrReclaimProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord>
  assertMaterializationExecution?(
    input: AssertProjectionMaterializationExecutionInput
  ): Promise<ProjectionMaterializationRunRecord>
  updateMaterialization?(
    input: UpdateProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord>
  finishMaterialization?(input: FinishProjectionMaterializationInput): Promise<ProjectionRunRecord>
  /** @internal Atomically linked by ontology materialization finalization. */
  recordMaterializationCommit?(
    projectId: string,
    bookkeeping: ProjectionRunMaterializationBookkeeping
  ): Promise<void>
  /** @internal Attach an exact committed replay without double-counting it. */
  recordMaterializationReplay?(
    projectId: string,
    replay: ProjectionRunMaterializationReplay
  ): Promise<void>
  start(input: StartProjectionRunInput): Promise<ProjectionRunRecord>
  update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord>
  finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null>
  list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult>
  listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult>
}

/** Strict capability required by the ontology Materializer, not by legacy run providers. */
export interface ProjectionMaterializationRunStorage extends ProjectionRunStorage {
  startOrReclaimMaterialization(
    input: StartOrReclaimProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord>
  assertMaterializationExecution(
    input: AssertProjectionMaterializationExecutionInput
  ): Promise<ProjectionMaterializationRunRecord>
  updateMaterialization(
    input: UpdateProjectionMaterializationInput
  ): Promise<ProjectionMaterializationRunRecord>
  finishMaterialization(input: FinishProjectionMaterializationInput): Promise<ProjectionRunRecord>
  recordMaterializationCommit(
    projectId: string,
    bookkeeping: ProjectionRunMaterializationBookkeeping
  ): Promise<void>
  recordMaterializationReplay(
    projectId: string,
    replay: ProjectionRunMaterializationReplay
  ): Promise<void>
}

export function isProjectionMaterializationRunStorage(
  storage: ProjectionRunStorage | null | undefined
): storage is ProjectionMaterializationRunStorage {
  return (
    storage != null &&
    typeof storage.startOrReclaimMaterialization === "function" &&
    typeof storage.assertMaterializationExecution === "function" &&
    typeof storage.updateMaterialization === "function" &&
    typeof storage.finishMaterialization === "function" &&
    typeof storage.recordMaterializationCommit === "function" &&
    typeof storage.recordMaterializationReplay === "function"
  )
}
