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
  ProjectionMaterializationRunRecord,
  ProjectionMaterializationRunStorage,
  ProjectionRunRecord,
} from "@sixb/core/storage"

export interface ProjectionWorkerContext extends SixbRuntimeContext {
  readonly projectionRunsStorage: ProjectionMaterializationRunStorage
  getDatasetById(datasetId: string): DatasetDefinition | null
  getProjectionById(projectionId: string): ProjectionDefinition | null
}

export interface ProjectionWorkerSixb extends SixbRuntimeContext {
  readonly id: string
  getObjectProjections(): readonly ObjectProjectionDefinition[]
  getLinkProjections(): readonly LinkProjectionDefinition[]
  getTelemetryProjections(): readonly TelemetryProjectionDefinition[]
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

export interface ClaimedProjectionExecution {
  readonly run: ProjectionMaterializationRunRecord
  readonly identity: ProjectionMaterializationIdentity
  readonly execution: {
    readonly projectionRunId: string
    readonly executionToken: string
  }
}
