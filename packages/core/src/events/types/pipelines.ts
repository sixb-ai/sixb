import type { SixbFailure } from "../../errors/types"
import type { PipelineRunFailureCode } from "../../storage/pipeline-runs/types"
import type { EventEnvelope } from "../envelope"

export interface PipelineRunStartedEvent extends EventEnvelope {
  type: "pipeline.run.started"
  topic: "pipelines"
  partitionKey: string
  payload: {
    pipelineId: string
    runId: string
    startedAt: string
  }
}

export interface PipelineRunStepStartedEvent extends EventEnvelope {
  type: "pipeline.run.step.started"
  topic: "pipelines"
  partitionKey: string
  payload: {
    pipelineId: string
    runId: string
    stepRunId: string
    stepId: string
    stepIndex: number
    totalSteps: number
    datasetId: string
    startedAt: string
  }
}

export interface PipelineRunStepFinishedEvent extends EventEnvelope {
  type: "pipeline.run.step.finished"
  topic: "pipelines"
  partitionKey: string
  payload: {
    pipelineId: string
    runId: string
    stepRunId: string
    stepId: string
    stepIndex: number
    totalSteps: number
    datasetId: string
    status: "succeeded" | "failed" | "cancelled"
    finishedAt: string
    versionId?: string
    rowsWritten?: number
    error?: SixbFailure<PipelineRunFailureCode>
  }
}

export interface PipelineRunFinishedEvent extends EventEnvelope {
  type: "pipeline.run.finished"
  topic: "pipelines"
  partitionKey: string
  payload: {
    pipelineId: string
    runId: string
    status: "succeeded" | "failed" | "cancelled"
    datasetId?: string
    versionId?: string
  }
}

export type PipelineEvent =
  | PipelineRunStartedEvent
  | PipelineRunStepStartedEvent
  | PipelineRunStepFinishedEvent
  | PipelineRunFinishedEvent
