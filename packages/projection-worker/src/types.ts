import type {
  DatasetDefinition,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  ProjectionKind,
  ProjectionRunCounters,
  ProjectionRunRecord,
  ProjectionRunStorage,
  SixbRuntimeContext,
  TelemetryProjectionDefinition,
} from "@sixb/core"

export interface ProjectionWorkerContext extends SixbRuntimeContext {
  readonly projectionRunsStorage: ProjectionRunStorage
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

export interface ProjectionJob {
  readonly id: string
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly datasetId: string
  readonly versionId: string
  readonly queueJobId?: string
}

export interface RunProjectionJobInput {
  readonly runtime: ProjectionWorkerContext
  readonly job: ProjectionJob
  readonly signal?: AbortSignal
  readonly batchSize?: number
}

export interface ProjectionJobResult extends ProjectionRunCounters {
  readonly id: string
  readonly projectionId: string
  readonly projectionKind: ProjectionKind
  readonly datasetId: string
  readonly datasetVersionId: string
  readonly run: ProjectionRunRecord
}

export interface ProjectionExecutionResult extends ProjectionRunCounters {
  readonly firstErrorMessage?: string
}

export type ProjectionProgressReporter = (counters: ProjectionRunCounters) => Promise<void> | void
