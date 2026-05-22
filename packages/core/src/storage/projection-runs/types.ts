export type ProjectionKind = "object" | "link"
export type ProjectionRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface ProjectionRunCounters {
  readonly rowsProcessed: number
  readonly rowsSkipped: number
  readonly objectsUpserted: number
  readonly linksUpserted: number
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
