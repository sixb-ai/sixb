import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { DatasetVersionRef, DatasetWriteMode } from "../../lake-storage"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ListLostRunsInput,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
} from "../run-claim"

export type PipelineRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"
export type PipelineStepRunStatus = Exclude<PipelineRunStatus, "queued">
/** Error codes a pipeline or pipeline-step run can persist and expose. */
export const PIPELINE_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "queue.enqueue_failed",
  "pipeline.step_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type PipelineRunFailureCode = (typeof PIPELINE_RUN_FAILURE_CODES)[number]

export interface PipelineRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly pipelineId: string
  readonly status: PipelineRunStatus
  /** Executions this run has used up. 0 until one takes it. */
  readonly attempt: number
  /** Absent unless a worker holds the run. */
  readonly execution?: RunExecution
  readonly queuedAt: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  /** Final step output in sequential V1. */
  readonly output?: DatasetVersionRef
  readonly error?: SixbFailure<PipelineRunFailureCode>
}

export interface PipelineStepRunRecord {
  readonly id: string
  readonly projectId: string
  readonly pipelineRunId: string
  readonly pipelineId: string
  readonly stepId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly status: PipelineStepRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly inputs: readonly DatasetVersionRef[]
  readonly output?: DatasetVersionRef
  readonly rowsWritten?: number
  readonly error?: SixbFailure<PipelineRunFailureCode>
}

export interface QueuePipelineRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly pipelineId: string
  readonly queuedAt?: Date
}

export type FinishPipelineRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output?: DatasetVersionRef
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "failed"
      readonly finishedAt?: Date
      readonly error: SixbFailure<PipelineRunFailureCode>
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "cancelled"
      readonly finishedAt?: Date
      readonly error?: SixbFailure<PipelineRunFailureCode>
    }

export interface StartPipelineStepRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken?: string
  readonly pipelineRunId: string
  readonly pipelineId: string
  readonly stepId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly startedAt?: Date
  readonly inputs: readonly DatasetVersionRef[]
}

export type FinishPipelineStepRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output: DatasetVersionRef
      readonly rowsWritten?: number
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly rowsWritten?: number
      readonly error?: SixbFailure<PipelineRunFailureCode>
    }

export interface ListPipelineRunsInput {
  readonly projectId: string
  readonly pipelineId?: string
  readonly pipelineIds?: readonly string[]
  readonly statuses?: readonly PipelineRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListPipelineRunsResult {
  readonly runs: readonly PipelineRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface ListLatestPipelineRunsInput {
  readonly projectId: string
  readonly pipelineIds: readonly string[]
  /** A status that never counts as the latest run. */
  readonly excludedStatus?: PipelineRunStatus
}

export interface ListLatestPipelineRunsResult {
  readonly runs: readonly PipelineRunRecord[]
}

export interface ListPipelineStepRunsInput {
  readonly projectId: string
  readonly pipelineRunId?: string
  /** The steps of these runs, in one read. Empty matches nothing. */
  readonly pipelineRunIds?: readonly string[]
  readonly pipelineId?: string
  readonly stepId?: string
  readonly datasetId?: string
  readonly statuses?: readonly PipelineStepRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListPipelineStepRunsResult {
  readonly steps: readonly PipelineStepRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface PipelineRunStorage {
  queue(input: QueuePipelineRunInput): Promise<PipelineRunRecord>
  /** Takes the run for one execution, or says why this delivery cannot. */
  startOrReclaim(input: ClaimRunInput): Promise<RunClaim<PipelineRunRecord>>
  /** Projects a renewed queue lease onto the run. */
  confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<PipelineRunRecord>
  /** Hands the run back. Does nothing once the token no longer holds a running run. */
  releaseExecution(input: ReleaseRunExecutionInput): Promise<void>
  listLost(input: ListLostRunsInput): Promise<readonly PipelineRunRecord[]>
  finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord>
  /**
   * Starting a step an earlier execution left running starts it over on the inputs given. It keeps
   * the time it first started, the earliest its output can have landed.
   */
  startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord>
  finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord>
  getById(params: { projectId: string; id: string }): Promise<PipelineRunRecord | null>
  list(input: ListPipelineRunsInput): Promise<ListPipelineRunsResult>
  listLatestByPipelineIds(input: ListLatestPipelineRunsInput): Promise<ListLatestPipelineRunsResult>
  listSteps(input: ListPipelineStepRunsInput): Promise<ListPipelineStepRunsResult>
}
