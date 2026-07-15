import type {
  DatasetDefinition,
  LakeStorage,
  PipelineDefinition,
  Queues,
  Storage,
} from "@sixb/core"
import type { EventsRuntime } from "@sixb/core/internal/events"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type {
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
} from "@sixb/core/storage"

export type PipelineLogSession = ReturnType<LogsRuntime["startExecution"]>

export interface PipelineWorkerContext {
  readonly id: string
  readonly pipelineRunsStorage: PipelineRunStorage
  readonly lakeStorage: LakeStorage
  readonly logs?: LogsRuntime
  getDatasetById(datasetId: string): DatasetDefinition | null
  getPipelineById(pipelineId: string): PipelineDefinition | null
}

export interface PipelineWorkerSixb {
  readonly id: string
  readonly events?: EventsRuntime
  readonly logs?: LogsRuntime
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
