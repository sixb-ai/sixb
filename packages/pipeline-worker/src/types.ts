import type {
  DatasetDefinition,
  DatasetVersion,
  EventsRuntime,
  LakeStorage,
  PipelineDefinition,
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
  Queues,
  Storage,
} from "@sixb/core"

export interface PipelineWorkerContext {
  readonly id: string
  readonly pipelineRunsStorage: PipelineRunStorage
  readonly lakeStorage: LakeStorage
  getDatasetById(datasetId: string): DatasetDefinition | null
  getPipelineById(pipelineId: string): PipelineDefinition | null
}

export interface PipelineWorkerSixb {
  readonly id: string
  readonly events?: EventsRuntime
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly storage: Storage
  getPipelineDefinitions(): readonly PipelineDefinition[]
  getPipelineById(pipelineId: string): PipelineDefinition | null
  getDatasetById(datasetId: string): DatasetDefinition | null
}

export interface PipelineJob {
  readonly id: string
  readonly pipelineId: string
}

export interface RunPipelineJobInput {
  readonly runtime: PipelineWorkerContext
  readonly job: PipelineJob
  readonly signal?: AbortSignal
  readonly onRunStarted?: PipelineRunStartedHandler
  readonly onStepStarted?: PipelineStepStartedHandler
  readonly onStepFinished?: PipelineStepFinishedHandler
  readonly onStepCommitted?: PipelineStepCommittedHandler
}

export type PipelineStepCommittedHandler = (result: PipelineStepRunResult) => Promise<void> | void

export type PipelineRunStartedHandler = (run: PipelineRunRecord) => Promise<void> | void

export interface PipelineStepLifecycleContext {
  readonly stepIndex: number
  readonly totalSteps: number
}

export type PipelineStepStartedHandler = (
  step: PipelineStepRunRecord,
  context: PipelineStepLifecycleContext
) => Promise<void> | void

export type PipelineStepFinishedHandler = (
  step: PipelineStepRunRecord,
  context: PipelineStepLifecycleContext
) => Promise<void> | void

export interface PipelineStepRunResult {
  readonly run: PipelineStepRunRecord
  readonly version: DatasetVersion
}

export interface PipelineRunResult {
  readonly run: PipelineRunRecord
  readonly steps: readonly PipelineStepRunResult[]
  readonly version?: DatasetVersion
}
