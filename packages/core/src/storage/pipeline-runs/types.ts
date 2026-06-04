import type { DatasetVersionRef, DatasetWriteMode } from "../../lake-storage"

export type PipelineRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface PipelineRunFailure {
  readonly name?: string
  readonly message: string
}

export interface PipelineRunRecord {
  readonly id: string
  readonly projectId: string
  readonly pipelineId: string
  readonly status: PipelineRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  /** Final step output in sequential V1. */
  readonly output?: DatasetVersionRef
  readonly error?: PipelineRunFailure
}

export interface PipelineStepRunRecord {
  readonly id: string
  readonly projectId: string
  readonly pipelineRunId: string
  readonly pipelineId: string
  readonly stepId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly status: PipelineRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly inputs: readonly DatasetVersionRef[]
  readonly output?: DatasetVersionRef
  readonly rowsWritten?: number
  readonly error?: PipelineRunFailure
}

export interface StartPipelineRunInput {
  readonly id: string
  readonly projectId: string
  readonly pipelineId: string
  readonly startedAt?: Date
}

export type FinishPipelineRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output?: DatasetVersionRef
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: PipelineRunFailure
    }

export interface StartPipelineStepRunInput {
  readonly id: string
  readonly projectId: string
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
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly output: DatasetVersionRef
      readonly rowsWritten?: number
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly rowsWritten?: number
      readonly error?: PipelineRunFailure
    }

export interface ListPipelineRunsInput {
  readonly projectId: string
  readonly pipelineId?: string
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
}

export interface ListLatestPipelineRunsResult {
  readonly runs: readonly PipelineRunRecord[]
}

export interface ListPipelineStepRunsInput {
  readonly projectId: string
  readonly pipelineRunId?: string
  readonly pipelineId?: string
  readonly stepId?: string
  readonly datasetId?: string
  readonly statuses?: readonly PipelineRunStatus[]
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
  start(input: StartPipelineRunInput): Promise<PipelineRunRecord>
  finish(input: FinishPipelineRunInput): Promise<PipelineRunRecord>
  startStep(input: StartPipelineStepRunInput): Promise<PipelineStepRunRecord>
  finishStep(input: FinishPipelineStepRunInput): Promise<PipelineStepRunRecord>
  getById(params: { projectId: string; id: string }): Promise<PipelineRunRecord | null>
  list(input: ListPipelineRunsInput): Promise<ListPipelineRunsResult>
  listLatestByPipelineIds(input: ListLatestPipelineRunsInput): Promise<ListLatestPipelineRunsResult>
  listSteps(input: ListPipelineStepRunsInput): Promise<ListPipelineStepRunsResult>
}
