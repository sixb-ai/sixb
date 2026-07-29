import type {
  PinnedDatasetVersion,
  ProjectionExecution,
  ProjectionMaterializationIdentity,
} from "../../materialization/model"

export type ProjectionKind = ProjectionMaterializationIdentity["projectionKind"]
export type ProjectionRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface ProjectionRunProgress {
  /** Physical immutable-version rows consumed, before normalization or semantic materialization. */
  readonly sourceRowsRead: number
  /** Physical rows intentionally skipped because a required mapped value was blank. */
  readonly sourceRowsSkipped: number
}

const progressKeyFlags: Record<keyof ProjectionRunProgress, true> = {
  sourceRowsRead: true,
  sourceRowsSkipped: true,
}

export const PROJECTION_RUN_PROGRESS_KEYS = Object.keys(
  progressKeyFlags
) as readonly (keyof ProjectionRunProgress)[]

export function zeroProjectionRunProgress(): ProjectionRunProgress {
  const progress = {} as Record<keyof ProjectionRunProgress, number>
  for (const key of PROJECTION_RUN_PROGRESS_KEYS) progress[key] = 0
  return progress
}

export interface ProjectionTelemetryCheckpoint {
  readonly fixedBatchSize: number
  readonly nextBatchOrdinal: number
  readonly nextRowOffset: number
  readonly inputExhausted: boolean
}

interface ProjectionRunRecordBase {
  readonly id: string
  readonly projectId: string
  readonly status: ProjectionRunStatus
  readonly attempt: number
  readonly progress: ProjectionRunProgress
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly errorMessage?: string
}

type ProjectionIdentity<TKind extends ProjectionKind> = Extract<
  ProjectionMaterializationIdentity,
  { readonly projectionKind: TKind }
>

export interface ObjectProjectionTarget {
  readonly objectTypeId: string
}

export interface LinkProjectionTarget {
  readonly sourceObjectTypeId: string
  readonly targetObjectTypeId: string
}

export type ProjectionRunTarget = ObjectProjectionTarget | LinkProjectionTarget

export type ObjectProjectionRunRecord = ProjectionRunRecordBase & {
  readonly identity: ProjectionIdentity<"object">
  readonly target: ObjectProjectionTarget
  readonly telemetryCheckpoint?: never
}

export type LinkProjectionRunRecord = ProjectionRunRecordBase & {
  readonly identity: ProjectionIdentity<"link">
  readonly target: LinkProjectionTarget
  readonly telemetryCheckpoint?: never
}

export type TelemetryProjectionRunRecord = ProjectionRunRecordBase & {
  readonly identity: ProjectionIdentity<"telemetry">
  readonly target: ObjectProjectionTarget
  readonly telemetryCheckpoint: ProjectionTelemetryCheckpoint
}

/** Durable projection lifecycle state. The execution token is deliberately returned separately. */
export type ProjectionRunRecord =
  | ObjectProjectionRunRecord
  | LinkProjectionRunRecord
  | TelemetryProjectionRunRecord

export function projectionRunObjectTypesVisible(
  run: ProjectionRunRecord,
  canView: (objectTypeId: string) => boolean
): boolean {
  return projectionTargetObjectTypesVisible(run.target, canView)
}

export function projectionTargetObjectTypesVisible(
  target: ProjectionRunTarget,
  canView: (objectTypeId: string) => boolean
): boolean {
  if ("sourceObjectTypeId" in target) {
    return canView(target.sourceObjectTypeId) && canView(target.targetObjectTypeId)
  }
  return canView(target.objectTypeId)
}

interface StartOrReclaimProjectionRunBase {
  readonly id: string
  readonly projectId: string
  /** Required for telemetry and forbidden for replacement. */
  readonly fixedBatchSize?: number
  readonly startedAt?: Date
}

export type StartOrReclaimProjectionRunInput =
  | (StartOrReclaimProjectionRunBase & {
      readonly identity: ProjectionIdentity<"object">
      readonly target: ObjectProjectionRunRecord["target"]
    })
  | (StartOrReclaimProjectionRunBase & {
      readonly identity: ProjectionIdentity<"link">
      readonly target: LinkProjectionRunRecord["target"]
    })
  | (StartOrReclaimProjectionRunBase & {
      readonly identity: ProjectionIdentity<"telemetry">
      readonly target: TelemetryProjectionRunRecord["target"]
      readonly fixedBatchSize: number
    })

export interface ProjectionRunClaim {
  readonly run: ProjectionRunRecord
  readonly execution: ProjectionExecution
}

export interface LockProjectionRunForMaterializationInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly identity: ProjectionMaterializationIdentity
}

export interface UpdateProjectionRunInput extends LockProjectionRunForMaterializationInput {
  readonly progress: Partial<ProjectionRunProgress>
}

export type FinishProjectionRunInput = (
  | { readonly status: "succeeded" }
  | { readonly status: "failed" | "cancelled"; readonly errorMessage?: string }
) &
  LockProjectionRunForMaterializationInput & {
    readonly finishedAt?: Date
    readonly progress?: Partial<ProjectionRunProgress>
  }

export interface AdvanceProjectionTelemetryCheckpointInput
  extends LockProjectionRunForMaterializationInput {
  /** Must equal the run's current nextBatchOrdinal. */
  readonly batchOrdinal: number
  /** Physical dataset rows consumed by this batch, including skipped rows. */
  readonly batchRowCount: number
  /** Physical rows intentionally skipped inside this batch. */
  readonly batchRowsSkipped: number
  /** True when this batch consumed the final row of the immutable dataset version. */
  readonly inputExhausted: boolean
}

export interface ListProjectionRunsInput {
  readonly projectId: string
  readonly projectionId?: string
  readonly projectionKind?: ProjectionKind
  readonly datasetId?: string
  readonly datasetVersionId?: string
  /**
   * Viewable object type ids. A run is included only if every target type is present. Omit for a
   * privileged caller; an empty set matches no runs.
   */
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
  startOrReclaim(input: StartOrReclaimProjectionRunInput): Promise<ProjectionRunClaim>
  /** Transactionally fences the current execution before ontology materialization writes. */
  lockForMaterialization(
    input: LockProjectionRunForMaterializationInput
  ): Promise<ProjectionRunRecord>
  /** Updates physical source progress only. */
  update(input: UpdateProjectionRunInput): Promise<ProjectionRunRecord>
  /** Advances telemetry progress atomically with the corresponding ontology commit. */
  advanceTelemetryCheckpoint(
    input: AdvanceProjectionTelemetryCheckpointInput
  ): Promise<TelemetryProjectionRunRecord>
  /** Telemetry success also records the worker's EOF observation atomically. */
  finish(input: FinishProjectionRunInput): Promise<ProjectionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ProjectionRunRecord | null>
  list(input: ListProjectionRunsInput): Promise<ListProjectionRunsResult>
  listLatestByProjectionIds(
    input: ListLatestProjectionRunsInput
  ): Promise<ListLatestProjectionRunsResult>
}

export type { PinnedDatasetVersion, ProjectionExecution, ProjectionMaterializationIdentity }
