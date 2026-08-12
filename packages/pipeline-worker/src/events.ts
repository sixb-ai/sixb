import type { DomainEventLog } from "@sixb/core"
import type {
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStepRunRecord,
} from "@sixb/core/storage"
import type { PipelineJob, PipelineStepLifecycleContext, PipelineStepRunResult } from "./types"

const SOURCE = "SixbPipelineWorker"

export async function emitPipelineRunStarted(
  events: DomainEventLog | undefined,
  run: Pick<PipelineRunRecord, "id" | "pipelineId" | "startedAt">
): Promise<void> {
  await events?.emit(
    {
      events: [
        {
          type: "pipeline.run.started",
          payload: {
            pipelineId: run.pipelineId,
            runId: run.id,
            startedAt: run.startedAt.toISOString(),
          },
        },
      ],
    },
    { source: SOURCE }
  )
}

export async function emitPipelineRunStepStarted(
  events: DomainEventLog | undefined,
  step: Pick<
    PipelineStepRunRecord,
    "id" | "pipelineRunId" | "pipelineId" | "stepId" | "datasetId" | "startedAt"
  >,
  context: PipelineStepLifecycleContext
): Promise<void> {
  await events?.emit(
    {
      events: [
        {
          type: "pipeline.run.step.started",
          payload: {
            pipelineId: step.pipelineId,
            runId: step.pipelineRunId,
            stepRunId: step.id,
            stepId: step.stepId,
            stepIndex: context.stepIndex,
            totalSteps: context.totalSteps,
            datasetId: step.datasetId,
            startedAt: step.startedAt.toISOString(),
          },
        },
      ],
    },
    { source: SOURCE }
  )
}

export async function emitPipelineRunStepFinished(
  events: DomainEventLog | undefined,
  step: Pick<
    PipelineStepRunRecord,
    | "id"
    | "pipelineRunId"
    | "pipelineId"
    | "stepId"
    | "datasetId"
    | "status"
    | "finishedAt"
    | "output"
    | "rowsWritten"
    | "error"
  >,
  context: PipelineStepLifecycleContext
): Promise<void> {
  await events?.emit(
    {
      events: [
        {
          type: "pipeline.run.step.finished",
          payload: {
            pipelineId: step.pipelineId,
            runId: step.pipelineRunId,
            stepRunId: step.id,
            stepId: step.stepId,
            stepIndex: context.stepIndex,
            totalSteps: context.totalSteps,
            datasetId: step.datasetId,
            status: requireTerminalStatus(step.status, `Pipeline step run '${step.id}'`),
            finishedAt: requireFinishedAt(step.id, step.finishedAt).toISOString(),
            ...(step.output ? { versionId: step.output.versionId } : {}),
            ...(step.rowsWritten !== undefined ? { rowsWritten: step.rowsWritten } : {}),
            ...(step.error ? { error: step.error } : {}),
          },
        },
      ],
    },
    { source: SOURCE }
  )
}

export async function emitDatasetVersionCommitted(
  events: DomainEventLog | undefined,
  job: PipelineJob,
  step: PipelineStepRunResult
): Promise<void> {
  if (!step.versionCreated) return

  // Emit step outputs immediately so dataset event schedules can react before later steps finish.
  await events?.emit(
    {
      events: [
        {
          type: "dataset.version.committed" as const,
          payload: {
            datasetId: step.version.datasetId,
            versionId: step.version.versionId,
            createdAt: step.version.createdAt.toISOString(),
            producer: {
              kind: "pipeline" as const,
              id: job.pipelineId,
              runId: job.id,
              stepId: step.run.stepId,
            },
          },
        },
      ],
    },
    { source: SOURCE }
  )
}

export async function emitPipelineRunFinished(
  events: DomainEventLog | undefined,
  run: Pick<PipelineRunRecord, "id" | "pipelineId" | "status" | "output" | "error">
): Promise<void> {
  await events?.emit(
    { events: [{ type: "pipeline.run.finished", payload: buildPipelineRunFinishedPayload(run) }] },
    { source: SOURCE }
  )
}

function buildPipelineRunFinishedPayload(
  run: Pick<PipelineRunRecord, "id" | "pipelineId" | "status" | "output" | "error">
) {
  return {
    pipelineId: run.pipelineId,
    runId: run.id,
    status: requireTerminalStatus(run.status, `Pipeline run '${run.id}'`),
    ...(run.output
      ? {
          datasetId: run.output.datasetId,
          versionId: run.output.versionId,
        }
      : {}),
    ...(run.error ? { error: run.error } : {}),
  }
}

function requireFinishedAt(stepRunId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw new Error(`[SixbPipelineWorker] Pipeline step run '${stepRunId}' has no finishedAt.`)
}

function requireTerminalStatus(
  status: PipelineRunStatus,
  context: string
): Exclude<PipelineRunStatus, "running"> {
  if (status === "running") {
    throw new Error(`[SixbPipelineWorker] ${context} is still running.`)
  }

  return status
}
