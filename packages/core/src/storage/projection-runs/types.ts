import type {
  PinnedDatasetVersion,
  ProjectionMaterializationIdentity,
} from "../../materialization/model"

export type ProjectionKind = "object" | "link" | "telemetry"
export type ProjectionRunStatus = "running" | "succeeded" | "failed" | "cancelled"
export type ProjectionMaterializationProtocol = "replacement" | "telemetry"

/**
 * Transitional storage alias for the canonical materialization model.
 * TODO(ontology-materializer/phase-6): Export PinnedDatasetVersion directly from the final contract.
 */
export type ProjectionRunDatasetVersion = PinnedDatasetVersion

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

export interface ProjectionTelemetryCheckpoint {
  readonly fixedBatchSize: number
  readonly nextBatchOrdinal: number
  readonly nextRowOffset: number
  readonly inputExhausted: boolean
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
  /** Present only for telemetry runs; replacement work has no partial committed checkpoint. */
  readonly telemetryCheckpoint?: ProjectionTelemetryCheckpoint
}

/**
 * Fully migrated record returned by the transitional fenced lifecycle.
 *
 * TODO(ontology-materializer/phase-6): Make this state required on ProjectionRunRecord, return the
 * execution token separately from the public record, and delete this compatibility type.
 */
export interface ProjectionMaterializationRunRecord extends ProjectionRunRecord {
  readonly attempt: number
  readonly executionToken: string
  readonly materializationProtocol: ProjectionMaterializationProtocol
  readonly datasetVersionCreatedAt: string
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
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
  readonly identity: ProjectionMaterializationIdentity
  /** Required for telemetry and forbidden for replacement. */
  readonly fixedBatchSize?: number
  readonly startedAt?: Date
}

export interface AssertProjectionMaterializationExecutionInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly identity: ProjectionMaterializationIdentity
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

export interface AdvanceProjectionTelemetryCheckpointInput
  extends AssertProjectionMaterializationExecutionInput {
  /** Must equal the run's current nextBatchOrdinal. */
  readonly batchOrdinal: number
  /** Physical dataset rows consumed by this batch, including skipped rows. */
  readonly batchRowCount: number
  /** True when this batch consumed the final row of the immutable dataset version. */
  readonly inputExhausted: boolean
}

/** Marks a telemetry run's immutable input as empty without creating an ontology batch commit. */
export type CompleteEmptyProjectionTelemetryInput = AssertProjectionMaterializationExecutionInput

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
  /**
   * Transitional fenced lifecycle used by the ontology Materializer.
   *
   * TODO(ontology-materializer/phase-6): Replace the legacy start/update/finish lifecycle with
   * these semantics, give the primary methods their final names, and make them required after the
   * projection worker and every provider migrate.
   */
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
  /**
   * @internal Advances telemetry resume state on the same transaction as its ontology commit.
   */
  advanceTelemetryCheckpoint?(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<ProjectionMaterializationRunRecord>
  /** @internal Used only by the Materializer's guarded projection-run finalizer. */
  completeEmptyTelemetryInput?(
    input: CompleteEmptyProjectionTelemetryInput
  ): Promise<ProjectionMaterializationRunRecord>
  /**
   * @deprecated Unfenced lifecycle retained while workers and providers migrate.
   * TODO(ontology-materializer/phase-6): Remove with the transitional capability below.
   */
  start(input: StartProjectionRunInput): Promise<ProjectionRunRecord>
  /** @deprecated See start(). */
  update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord>
  /** @deprecated See start(). */
  finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null>
  list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult>
  listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult>
}

/**
 * Transitional required view used while ProjectionRunStorage supports legacy providers.
 *
 * TODO(ontology-materializer/phase-6): Delete this interface and its type guard after the fenced
 * lifecycle becomes the required ProjectionRunStorage contract.
 */
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
  advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<ProjectionMaterializationRunRecord>
  completeEmptyTelemetryInput(
    input: CompleteEmptyProjectionTelemetryInput
  ): Promise<ProjectionMaterializationRunRecord>
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
    typeof storage.advanceTelemetryCheckpoint === "function" &&
    typeof storage.completeEmptyTelemetryInput === "function"
  )
}
