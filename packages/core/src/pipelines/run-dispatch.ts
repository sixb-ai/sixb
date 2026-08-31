import { randomUUID } from "node:crypto"
import { reportRunFailure } from "../error-reporting/capability"
import { createSixbError, toSixbFailure } from "../errors/internal"
import type { SixbFailure } from "../errors/types"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type {
  CreateExecutionInput,
  PipelineRunFailureCode,
  PipelineRunRecord,
  Storage,
} from "../storage"
import { PIPELINE_RUN_FAILURE_CODES, PipelineRunError } from "../storage"
import { PipelineError } from "./errors"
import type { PipelineRunRequestOptions, PipelineRunRequestResult } from "./request"
import type { PipelineDefinition } from "./types"

export type AutomaticPipelineExecutionSource =
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }

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
}

type PersistedPipelineRun =
  | { readonly publish: false; readonly run: PipelineRunRecord }
  | {
      readonly publish: true
      readonly run: PipelineRunRecord
      readonly execution: CreateExecutionInput
      readonly queuedAt: Date
      readonly created: boolean
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
  const runId = createPipelineRunId(input.runId)
  const persisted = await persistPipelineRun(input, runId)
  if (!persisted.publish) return existingPipelineRunResult(persisted.run)
  return publishPipelineRun(input, persisted)
}

async function persistPipelineRun(
  input: DispatchPipelineRunInput,
  runId: string
): Promise<PersistedPipelineRun> {
  const pipelineRuns = requirePipelineRunStorage(input.storage)
  const existing = await pipelineRuns.getById({ projectId: input.projectId, id: runId })
  if (existing) return reusePipelineRun(input, existing)

  const execution = await input.createExecution(`exec_${randomUUID()}`, runId)
  const queuedAt = new Date()
  try {
    return await input.storage.transaction(
      async (tx): Promise<PersistedPipelineRun> => {
        const transactionalRuns = requirePipelineRunStorage(tx)
        const raced = await transactionalRuns.getById({ projectId: input.projectId, id: runId })
        if (raced) {
          assertExistingRunMatchesRequest(raced, input)
          await input.validateExistingRun?.(raced, tx)
          return { publish: false, run: raced }
        }

        await tx.executions.create(execution)
        const run = await transactionalRuns.queue({
          projectId: input.projectId,
          id: runId,
          executionId: execution.id,
          pipelineId: input.pipeline.id,
          queuedAt,
        })
        return { publish: true, run, execution, queuedAt, created: true }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!(error instanceof PipelineRunError)) throw error
    const raced = await pipelineRuns.getById({ projectId: input.projectId, id: runId })
    if (!raced) throw error
    assertExistingRunMatchesRequest(raced, input)
    await input.validateExistingRun?.(raced, input.storage)
    return { publish: false, run: raced }
  }
}

async function reusePipelineRun(
  input: DispatchPipelineRunInput,
  existing: PipelineRunRecord
): Promise<PersistedPipelineRun> {
  assertExistingRunMatchesRequest(existing, input)
  await input.validateExistingRun?.(existing, input.storage)
  if (
    existing.status !== "failed" ||
    existing.error?.code !== "queue.enqueue_failed" ||
    !existing.error.retryable
  ) {
    return { publish: false, run: existing }
  }

  const execution = await input.storage.executions.getById({
    projectId: input.projectId,
    id: existing.executionId,
  })
  if (!execution) {
    throw new PipelineRunError(
      `[Sixb] Execution '${existing.executionId}' for Pipeline run '${existing.id}' was not found.`
    )
  }

  const queuedAt = new Date()
  const run = await requirePipelineRunStorage(input.storage).queue({
    projectId: input.projectId,
    id: existing.id,
    executionId: existing.executionId,
    pipelineId: existing.pipelineId,
    queuedAt,
  })
  return { publish: true, run, execution, queuedAt, created: false }
}

async function publishPipelineRun(
  input: DispatchPipelineRunInput,
  persisted: Extract<PersistedPipelineRun, { readonly publish: true }>
): Promise<PipelineRunRequestResult> {
  try {
    const [job] = await input.queue.enqueue({
      projectId: input.projectId,
      jobs: [
        {
          id: persisted.run.id,
          type: "pipeline.run.requested",
          payload: { runId: persisted.run.id },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      ],
    })
    return {
      pipelineId: persisted.run.pipelineId,
      runId: persisted.run.id,
      queuedAt: persisted.queuedAt.toISOString(),
      ...(job?.id ? { jobId: job.id } : {}),
      created: persisted.created,
    }
  } catch (error) {
    const failedAt = new Date()
    const failure = toEnqueueFailure(error, persisted.run, failedAt)
    const failed = await requirePipelineRunStorage(input.storage).finish({
      projectId: input.projectId,
      id: persisted.run.id,
      status: "failed",
      finishedAt: failedAt,
      error: failure,
    })
    reportRunFailure(input.errorReporterHost, error, {
      projectId: input.projectId,
      runKind: "pipeline",
      run: { runId: failed.id, pipelineId: failed.pipelineId },
      failure,
    })
    throw error
  }
}

function assertExistingRunMatchesRequest(
  existing: PipelineRunRecord,
  input: Pick<DispatchPipelineRunInput, "pipeline">
): void {
  if (existing.pipelineId !== input.pipeline.id) {
    throw new PipelineRunError(
      `[Sixb] Pipeline run '${existing.id}' already exists with a different request payload.`
    )
  }
}

function existingPipelineRunResult(existing: PipelineRunRecord): PipelineRunRequestResult {
  return {
    pipelineId: existing.pipelineId,
    runId: existing.id,
    queuedAt: existing.queuedAt.toISOString(),
    created: false,
  }
}

function requirePipelineRunStorage(storage: Storage): NonNullable<Storage["pipelineRuns"]> {
  if (!storage.pipelineRuns) {
    throw new PipelineError("[Sixb] Pipeline run storage is not configured.")
  }
  return storage.pipelineRuns
}

function createPipelineRunId(runId: string | undefined): string {
  if (runId === undefined) return `run_${randomUUID()}`
  if (!runId.trim()) throw new PipelineError("[Sixb] Pipeline run id must not be empty")
  return runId
}

function assertAutomaticDispatchInput(input: AutomaticPipelineRunDispatchInput): void {
  assertNonBlank(input.pipelineId, "Pipeline id")
  assertNonBlank(input.runId, "Pipeline run id")
  assertNonBlank(input.source.eventId, "Pipeline source event id")
  assertNonBlank(input.correlationId, "Pipeline correlation id")
}

async function assertAutomaticExecutionIdentity(
  storage: Storage,
  projectId: string,
  input: AutomaticPipelineRunDispatchInput,
  run: PipelineRunRecord
): Promise<void> {
  const execution = await storage.executions.getById({ projectId, id: run.executionId })
  if (
    !execution ||
    execution.source.type !== input.source.type ||
    execution.source.eventId !== input.source.eventId ||
    execution.correlationId !== input.correlationId ||
    execution.requestedBy !== undefined
  ) {
    throw new PipelineError(
      `[Sixb] Pipeline run '${run.id}' already exists with different automatic provenance.`
    )
  }
}

function toEnqueueFailure(
  error: unknown,
  run: PipelineRunRecord,
  at: Date
): SixbFailure<PipelineRunFailureCode> {
  const enqueueError = createSixbError(
    "queue.enqueue_failed",
    `[Sixb] Could not enqueue Pipeline run '${run.id}'.`,
    {
      cause: error,
      details: { pipelineId: run.pipelineId, runId: run.id, phase: "enqueue" },
    }
  )
  return toSixbFailure(enqueueError, { allowedCodes: PIPELINE_RUN_FAILURE_CODES, at })
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new PipelineError(`[Sixb] ${label} must not be empty.`)
}
