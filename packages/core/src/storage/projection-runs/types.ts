export type ProjectionKind = "object" | "link" | "telemetry"
export type ProjectionRunStatus = "running" | "succeeded" | "failed" | "cancelled"

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
  /** Generic ontology commit linkage written atomically by the materializer. */
  readonly commitId?: string
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
  /** @internal Phase 1 materializer linkage; optional until every provider is switched. */
  recordMaterializationCommit?(
    projectId: string,
    bookkeeping: Extract<
      import("../ontology").MaterializationRunBookkeeping,
      { readonly kind: "projection" }
    >
  ): Promise<void>
  /** @internal Attach a replaying run to an already committed materialization. */
  recordMaterializationReplay?(projectId: string, runId: string, commitId: string): Promise<void>
  start(input: StartProjectionRunInput): Promise<ProjectionRunRecord>
  update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord>
  finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null>
  list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult>
  listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult>
}
