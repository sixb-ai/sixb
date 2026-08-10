import type {
  BlobsRuntime,
  DatasetsRuntime,
  ProjectionsRuntime,
  SixbRuntimeContext,
} from "@sixb/core"
import type { ProjectionMaterializationIdentity } from "@sixb/core/internal/materialization"
import type {
  ProjectionRunClaim,
  ProjectionRunRecord,
  ProjectionRunStorage,
} from "@sixb/core/storage"

export interface ProjectionWorkerContext extends SixbRuntimeContext {
  readonly projectionRunsStorage: ProjectionRunStorage
  readonly datasets: Pick<DatasetsRuntime, "getById">
  readonly projections: Pick<ProjectionsRuntime, "getById">
}

export interface ProjectionWorkerSixb extends Omit<SixbRuntimeContext, "blobStorage" | "rules"> {
  readonly id: string
  readonly blobs: Pick<BlobsRuntime, "put" | "open" | "stat">
  readonly datasets: Pick<DatasetsRuntime, "getById">
  readonly projections: Pick<ProjectionsRuntime, "list" | "getById">
}

export type ProjectionJob = ProjectionMaterializationIdentity & {
  /** Stable logical run id; identical to the durable queue job id. */
  readonly id: string
}

export interface RunProjectionJobInput {
  readonly runtime: ProjectionWorkerContext
  readonly job: ProjectionJob
  readonly signal?: AbortSignal
  /**
   * Clock for the missing-target grace window, measured from the run's own `startedAt`.
   *
   * A test seam: production reads `Date.now()`. Nothing else here needs a clock, so it is
   * not a general injection point.
   */
  readonly now?: () => number
  /** Test seam only. Production always uses the protocol constant (500 physical rows). */
  readonly telemetryBatchSize?: number
  readonly onRunFailed?: ProjectionRunFailedHandler
}

export type ProjectionRunFailedHandler = (error: unknown, run: ProjectionRunRecord) => void

export interface ProjectionJobResult {
  readonly run: ProjectionRunRecord
  /** True when a terminal redelivery required no source read. */
  readonly replayedTerminal: boolean
}

export type ClaimedProjectionExecution = ProjectionRunClaim
