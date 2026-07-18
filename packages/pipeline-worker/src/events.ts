import type { EventsRuntime } from "@sixb/core/internal/events"
import type {
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStepRunRecord,
} from "@sixb/core/storage"
import type {
  PipelineJob,
  PipelineStepLifecycleContext,
  PipelineStepRunResult,
  PipelineWorkerSixb,
} from "./types"

export async function emitPipelineRunStarted(
  events: EventsRuntime | undefined,
  run: Pick<PipelineRunRecord, "id" | "pipelineId" | "startedAt">
): Promise<void> {
  if (!events) return

  try {
    await events.append({
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
    })
  } catch (error) {
    console.error("[SixbPipelineWorker] Failed to emit pipeline.run.started:", error)
  }
}

export async function emitPipelineRunStepStarted(
  events: EventsRuntime | undefined,
  step: Pick<
    PipelineStepRunRecord,
    "id" | "pipelineRunId" | "pipelineId" | "stepId" | "datasetId" | "startedAt"
  >,
  context: PipelineStepLifecycleContext
): Promise<void> {
  if (!events) return

  try {
    await events.append({
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
    })
  } catch (error) {
    console.error("[SixbPipelineWorker] Failed to emit pipeline.run.step.started:", error)
  }
}

export async function emitPipelineRunStepFinished(
  events: EventsRuntime | undefined,
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
  if (!events) return

  try {
    await events.append({
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
            ...(step.error ? { error: step.error.message } : {}),
          },
        },
      ],
    })
  } catch (error) {
    console.error("[SixbPipelineWorker] Failed to emit pipeline.run.step.finished:", error)
  }
}

export async function emitDatasetVersionCommitted(
  sixb: PipelineWorkerSixb,
  job: PipelineJob,
  step: PipelineStepRunResult
): Promise<void> {
  if (!sixb.events || !step.versionCommitted) return

  try {
    // Emit step outputs immediately so dataset event schedules can react before later steps finish.
    await sixb.events.append({
      events: [
        {
          type: "dataset.version.committed" as const,
          payload: {
            datasetId: step.version.datasetId,
            versionId: step.version.versionId,
            producer: {
              kind: "pipeline" as const,
              id: job.pipelineId,
              runId: job.id,
              stepId: step.run.stepId,
            },
          },
        },
      ],
    })
  } catch (error) {
    console.error("[SixbPipelineWorker] Failed to emit dataset.version.committed:", error)
  }
}

export async function emitPipelineRunFinished(
  events: EventsRuntime | undefined,
  job: {
    readonly id: string
    readonly pipelineId: string
    readonly status: "succeeded" | "failed" | "cancelled"
    readonly datasetId?: string
    readonly versionId?: string
  }
): Promise<void> {
  if (!events) return

  try {
    await events.append({
      events: [
        {
          type: "pipeline.run.finished",
          payload: buildPipelineRunFinishedPayload(job),
        },
      ],
    })
  } catch (error) {
    console.error("[SixbPipelineWorker] Failed to emit pipeline.run.finished:", error)
  }
}

function buildPipelineRunFinishedPayload(job: {
  readonly id: string
  readonly pipelineId: string
  readonly status: "succeeded" | "failed" | "cancelled"
  readonly datasetId?: string
  readonly versionId?: string
}) {
  return {
    pipelineId: job.pipelineId,
    runId: job.id,
    status: job.status,
    ...(job.datasetId && job.versionId
      ? {
          datasetId: job.datasetId,
          versionId: job.versionId,
        }
      : {}),
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
