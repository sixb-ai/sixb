import type {
  DomainEventLog,
  LakeStorage,
  Queues,
  SixbDefinitions,
  SixbFailure,
  Storage,
} from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { PrimitiveExecutionHost } from "@sixb/core/internal/primitive-execution"
import type { HeldRunClaim } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type {
  PipelineRunFailureCode,
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
  /** Fences what this execution writes to the run's record. */
  readonly executionToken: string
}

export interface RunPipelineJobInput {
  readonly runtime: PipelineWorkerContext
  /** The run this delivery holds, and whether an earlier execution already worked on it. */
  readonly claim: HeldRunClaim<PipelineRunRecord>
  readonly signal?: AbortSignal
  readonly onRunStarted?: PipelineRunStartedHandler
  readonly onRunFinished?: PipelineRunFinishedHandler
  readonly onRunFailed?: PipelineRunFailedHandler
  readonly onStepStarted?: PipelineStepStartedHandler
  readonly onStepFinished?: PipelineStepFinishedHandler
  readonly onStepCommitted?: PipelineStepCommittedHandler
}

export type PipelineStepCommittedHandler = (result: PipelineStepRunResult) => Promise<void> | void

export type PipelineRunStartedHandler = (run: PipelineRunRecord) => Promise<void> | void

export type PipelineRunFinishedHandler = (run: PipelineRunRecord) => Promise<void> | void

export type PipelineRunFailedHandler = (
  error: unknown,
  run: PipelineRunRecord,
  failure: SixbFailure<PipelineRunFailureCode>
) => void

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
  /** The steps this delivery ran. Those an earlier one finished are on the durable run. */
  readonly steps: readonly PipelineStepRunResult[]
  readonly version?: DatasetVersion
}
