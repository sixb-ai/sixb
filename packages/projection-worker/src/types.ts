import type {
  DatasetDefinition,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  SixbRuntimeContext,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import type { ProjectionMaterializationIdentity } from "@sixb/core/internal/materialization"
import type {
  ProjectionRunClaim,
  ProjectionRunRecord,
  ProjectionRunStorage,
} from "@sixb/core/storage"

export interface ProjectionWorkerContext extends SixbRuntimeContext {
  readonly projectionRunsStorage: ProjectionRunStorage
  getDatasetById(datasetId: string): DatasetDefinition | null
  getProjectionById(projectionId: string): ProjectionDefinition | null
}

export interface ProjectionWorkerSixb extends SixbRuntimeContext {
  readonly id: string
  listObjectProjections(): readonly ObjectProjectionDefinition[]
  listLinkProjections(): readonly LinkProjectionDefinition[]
  listTelemetryProjections(): readonly TelemetryProjectionDefinition[]
  getDatasetById(datasetId: string): DatasetDefinition | null
  getProjectionById(projectionId: string): ProjectionDefinition | null
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
   * Which delivery of this job is running, from the queue's claim counter.
   *
   * Only a missing telemetry target reads it: that failure is retryable until the attempt
   * budget is spent, and terminal after. Defaults to the first delivery, so a caller that
   * does not track deliveries gets the retryable reading rather than a premature failure.
   */
  readonly attempt?: number
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
