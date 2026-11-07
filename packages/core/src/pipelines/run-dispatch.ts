import { reportRunFailure } from "../error-reporting/capability"
import { toSixbFailure } from "../errors/internal"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import {
  dispatchQueuedRun,
  hasAutomaticRunProvenance,
  type QueuedRunPrimitive,
  type RunPublication,
} from "../execution/queued-run-dispatch"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type { CreateExecutionInput, PipelineRunRecord, Storage } from "../storage"
import { PIPELINE_RUN_FAILURE_CODES, PipelineRunError } from "../storage"
import { PipelineError } from "./errors"
import type { PipelineRunRequestOptions, PipelineRunRequestResult } from "./request"
import type { PipelineDefinition } from "./types"

export type AutomaticPipelineExecutionSource =
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }
  | { readonly type: "datasetVersion"; readonly datasetId: string; readonly versionId: string }

export interface AutomaticPipelineRunDispatchInput extends PipelineRunRequestOptions {
  readonly pipelineId: string
  readonly runId: string
  readonly source: AutomaticPipelineExecutionSource
  readonly correlationId: string
  readonly metadata?: Readonly<Record<string, string>>
}

export type PipelineRunDispatchPort = RunDispatcher<
  AutomaticPipelineRunDispatchInput,
  PipelineRunRequestResult
>

export interface PipelineRunDispatcherDependencies {
  readonly id: string
  readonly definitions: Pick<SixbDefinitions, "pipelines">
  readonly storage: Storage
  readonly queues: Pick<Queues, "pipelines">
}

interface DispatchPipelineRunInput extends PipelineRunRequestOptions {
  readonly errorReporterHost: object
  readonly projectId: string
  readonly pipeline: PipelineDefinition
  readonly storage: Storage
  readonly queue: Queues["pipelines"]
  readonly metadata?: Readonly<Record<string, string>>
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
  readonly validateExistingRun?: (run: PipelineRunRecord, storage: Storage) => Promise<void>
  /** Return a run of this Pipeline that has not started yet instead of queueing another one. */
  readonly joinQueuedRun?: boolean
}

/** Core-owned durable dispatch boundary used by automatic Pipeline triggers. */
export class PipelineRunDispatcher implements PipelineRunDispatchPort {
  constructor(private readonly dependencies: PipelineRunDispatcherDependencies) {}

  async dispatch(input: AutomaticPipelineRunDispatchInput): Promise<PipelineRunRequestResult> {
    assertAutomaticDispatchInput(input)
    const pipeline = this.dependencies.definitions.pipelines.getById(input.pipelineId)
    if (!pipeline) throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)

    return dispatchPipelineRun({
      errorReporterHost: this.dependencies,
      projectId: this.dependencies.id,
      pipeline,
      storage: this.dependencies.storage,
      queue: this.dependencies.queues.pipelines,
      runId: input.runId,
      metadata: input.metadata,
      validateExistingRun: (run, storage) =>
        assertAutomaticExecutionIdentity(storage, this.dependencies.id, input, run),
      joinQueuedRun: true,
      createExecution: async (executionId, runId) =>
        createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "pipeline", id: pipeline.id, runId },
          origin: {
            type: "automatic",
            projectId: this.dependencies.id,
            source: input.source,
            correlationId: input.correlationId,
          },
        }),
    })
  }
}

/** Persist a Pipeline execution and queued run before publishing its queue job. */
export async function dispatchPipelineRun(
  input: DispatchPipelineRunInput
): Promise<PipelineRunRequestResult> {
  return dispatchQueuedRun({
    primitive: pipelineRunPrimitive(input),
    projectId: input.projectId,
    storage: input.storage,
    runId: input.runId,
    metadata: input.metadata,
    createExecution: input.createExecution,
    validateExistingRun: input.validateExistingRun,
    joinQueuedRun: input.joinQueuedRun,
  })
}

/**
 * A run that has not started reads each input's latest version when its steps start, so any queued
 * run of this Pipeline already covers a trigger that arrives now.
 */
function pipelineRunPrimitive(
  input: DispatchPipelineRunInput
): QueuedRunPrimitive<PipelineRunRecord, PipelineRunRequestResult> {
  const { projectId, pipeline } = input

  return {
    label: "Pipeline",
    failureDetails: (run) => ({ pipelineId: run.pipelineId }),

    runs: requirePipelineRunStorage,
    matches: (run) => run.pipelineId === pipeline.id,

    queueRun: (storage, run) =>
      requirePipelineRunStorage(storage).queue({
        projectId,
        id: run.id,
        executionId: run.executionId,
        pipelineId: pipeline.id,
        queuedAt: run.queuedAt,
      }),

    requeueRun: (storage, run, queuedAt) =>
      requirePipelineRunStorage(storage).queue({
        projectId,
        id: run.id,
        executionId: run.executionId,
        pipelineId: run.pipelineId,
        queuedAt,
      }),

    async oldestQueuedRun(storage) {
      const { runs } = await requirePipelineRunStorage(storage).list({
        projectId,
        pipelineId: pipeline.id,
        statuses: ["queued"],
        order: "asc",
        limit: 1,
      })
      return runs[0]
    },

    async enqueue(job) {
      const [enqueued] = await input.queue.enqueue({
        projectId,
        jobs: [
          {
            id: job.id,
            type: "pipeline.run.requested",
            payload: { runId: job.runId },
            ...(job.metadata === undefined ? {} : { metadata: job.metadata }),
          },
        ],
      })
      return enqueued
    },

    async failPublication(run, failure, cause, at) {
      const pipelineFailure = toSixbFailure(failure, {
        allowedCodes: PIPELINE_RUN_FAILURE_CODES,
        at,
      })
      const failed = await requirePipelineRunStorage(input.storage).finish({
        projectId,
        id: run.id,
        status: "failed",
        finishedAt: at,
        error: pipelineFailure,
      })
      reportRunFailure(input.errorReporterHost, cause, {
        projectId,
        runKind: "pipeline",
        run: { runId: failed.id, pipelineId: failed.pipelineId },
        failure: pipelineFailure,
      })
    },

    result: toRequestResult,

    runError: (message) => new PipelineRunError(message),
    isRunError: (error) => error instanceof PipelineRunError,
    requestError: (message) => new PipelineError(message),
  }
}

function toRequestResult(
  run: PipelineRunRecord,
  publication?: RunPublication
): PipelineRunRequestResult {
  return {
    pipelineId: run.pipelineId,
    runId: run.id,
    queuedAt: (publication?.queuedAt ?? run.queuedAt).toISOString(),
    ...(publication ? { jobId: publication.jobId } : {}),
    created: publication?.created ?? false,
  }
}

function requirePipelineRunStorage(storage: Storage): NonNullable<Storage["pipelineRuns"]> {
  if (!storage.pipelineRuns) {
    throw new PipelineError("[Sixb] Pipeline run storage is not configured.")
  }
  return storage.pipelineRuns
}

function assertAutomaticDispatchInput(input: AutomaticPipelineRunDispatchInput): void {
  assertNonBlank(input.pipelineId, "Pipeline id")
  assertNonBlank(input.runId, "Pipeline run id")
  if (input.source.type !== "datasetVersion") {
    assertNonBlank(input.source.eventId, "Pipeline source event id")
  }
  assertNonBlank(input.correlationId, "Pipeline correlation id")
}

async function assertAutomaticExecutionIdentity(
  storage: Storage,
  projectId: string,
  input: AutomaticPipelineRunDispatchInput,
  run: PipelineRunRecord
): Promise<void> {
  const execution = await storage.executions.getById({ projectId, id: run.executionId })
  if (!hasAutomaticRunProvenance(execution, input)) {
    throw new PipelineError(
      `[Sixb] Pipeline run '${run.id}' already exists with different automatic provenance.`
    )
  }
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new PipelineError(`[Sixb] ${label} must not be empty.`)
}
