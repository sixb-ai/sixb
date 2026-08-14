import type { DomainEventLog, LakeStorage, Queues, SixbDefinitions, Storage } from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { PrimitiveExecutionHost } from "@sixb/core/internal/primitive-execution"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type {
  PipelineRunRecord,
  PipelineRunStorage,
  PipelineStepRunRecord,
} from "@sixb/core/storage"

export type PipelineLogSession = ReturnType<LoggingService["startExecution"]>

export interface PipelineWorkerContext {
  readonly id: string
  readonly pipelineRunsStorage: PipelineRunStorage
  readonly lakeStorage: LakeStorage
  readonly logging?: LoggingService
  readonly datasets: Pick<SixbDefinitions["datasets"], "getById">
  readonly pipelines: Pick<SixbDefinitions["pipelines"], "getById">
}

export interface PipelineWorkerHost extends PrimitiveExecutionHost {
  readonly id: string
  readonly events?: DomainEventLog
  readonly logging?: LoggingService
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly storage: Storage
  readonly definitions: Pick<SixbDefinitions, "pipelines" | "datasets">
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
  readonly onRunFailed?: PipelineRunFailedHandler
  readonly onStepStarted?: PipelineStepStartedHandler
  readonly onStepFinished?: PipelineStepFinishedHandler
  readonly onStepCommitted?: PipelineStepCommittedHandler
}

export type PipelineStepCommittedHandler = (result: PipelineStepRunResult) => Promise<void> | void

export type PipelineRunStartedHandler = (run: PipelineRunRecord) => Promise<void> | void

export type PipelineRunFailedHandler = (error: unknown, run: PipelineRunRecord) => void

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
  /** True only when this step created the returned dataset version. */
  readonly versionCreated: boolean
}

export interface PipelineRunResult {
  readonly run: PipelineRunRecord
  readonly steps: readonly PipelineStepRunResult[]
  readonly version?: DatasetVersion
}
