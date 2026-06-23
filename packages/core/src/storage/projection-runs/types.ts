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

export interface ProjectionRunRecord extends ProjectionRunCounters {
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
}

export interface StartProjectionRunInput {
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

export interface ProjectionRunStorage {
  start(input: StartProjectionRunInput): Promise<ProjectionRunRecord>
  update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord>
  finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null>
  list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult>
}
