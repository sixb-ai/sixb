import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { createSixbError, type SixbCodedError } from "../errors/internal"
import type { CreateExecutionInput, ExecutionRecord, Storage } from "../storage"

/** A durable run that waits for a worker: the part of a Sync or Pipeline run dispatch reads. */
export interface QueuedRun {
  readonly id: string
  readonly executionId: string
  readonly status: string
  readonly queuedAt: Date
  readonly error?: { readonly code: string; readonly retryable: boolean }
}

export interface QueuedRunStore<TRun extends QueuedRun> {
  getById(params: { projectId: string; id: string }): Promise<TRun | null>
}

export type RunDispatchProvenance =
  | { readonly type: "schedule" | "event"; readonly eventId: string }
  | { readonly type: "datasetVersion"; readonly datasetId: string; readonly versionId: string }

/** What a primitive supplies to run dispatch: everything else about admission is shared. */
export interface QueuedRunPrimitive<TRun extends QueuedRun, TResult> {
  /** Capitalized, as error messages name it. */
  readonly label: string
  /** Details that identify the primitive in a failure, beside the run id. */
  failureDetails(run: TRun): Readonly<Record<string, string>>

  runs(storage: Storage): QueuedRunStore<TRun>
  /** A run of this definition, with this same request, could serve as this one. */
  matches(run: TRun): boolean
  queueRun(
    storage: Storage,
    run: { readonly id: string; readonly executionId: string; readonly queuedAt: Date }
  ): Promise<TRun>
  /** Queue again a run whose job could not be published. */
  requeueRun(storage: Storage, run: TRun, queuedAt: Date): Promise<TRun>
  /** The oldest run of this definition that has not started, whatever its request. */
  oldestQueuedRun(storage: Storage): Promise<TRun | undefined>

  enqueue(job: {
    readonly id: string
    readonly runId: string
    readonly metadata?: Readonly<Record<string, string>>
  }): Promise<{ readonly id: string } | undefined>
  /** Record and report that the run's job could not be published. */
  failPublication(run: TRun, failure: SixbCodedError, cause: unknown, at: Date): Promise<void>

  result(run: TRun, publication?: RunPublication): TResult

  /** The error that says a run record cannot serve this request. */
  runError(message: string): Error
  isRunError(error: unknown): boolean
  /** The error that says the request itself is malformed. */
  requestError(message: string): Error
}

export interface RunPublication {
  readonly queuedAt: Date
  readonly jobId: string
  readonly created: boolean
}

export interface DispatchQueuedRunInput<TRun extends QueuedRun, TResult> {
  readonly primitive: QueuedRunPrimitive<TRun, TResult>
  readonly projectId: string
  readonly storage: Storage
  readonly runId?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
  readonly validateExistingRun?: (run: TRun, storage: Storage) => Promise<void>
  /** Return a matching run that has not started yet instead of queueing another one. */
  readonly joinQueuedRun?: boolean
}

type PersistedRun<TRun extends QueuedRun> =
  | { readonly publish: false; readonly run: TRun }
  | {
      readonly publish: true
      readonly run: TRun
      readonly queuedAt: Date
      readonly created: boolean
      /** Defaults to the run id. A trigger that joins a run publishes its own job for it. */
      readonly jobId?: string
    }

/** Persist an execution and a queued run before publishing the run's queue job. */
export async function dispatchQueuedRun<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>
): Promise<TResult> {
  const runId = createRunId(input)

  let persisted = await persistRun(input, runId)
  if (!persisted.publish && input.validateExistingRun && persisted.run.status === "queued") {
    persisted = await reuseRun(input, persisted.run)
  }

  if (!persisted.publish) return input.primitive.result(persisted.run)
  return publishRun(input, persisted)
}

async function persistRun<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  runId: string
): Promise<PersistedRun<TRun>> {
  const { primitive } = input

  const existing = await primitive
    .runs(input.storage)
    .getById({ projectId: input.projectId, id: runId })
  if (existing) return reuseRun(input, existing)

  const execution = await input.createExecution(`exec_${randomUUID()}`, runId)
  const queuedAt = new Date()

  try {
    return await input.storage.transaction(
      (tx) => persistRunInTransaction(input, tx, runId, execution, queuedAt),
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!primitive.isRunError(error)) throw error

    const raced = await primitive
      .runs(input.storage)
      .getById({ projectId: input.projectId, id: runId })
    if (!raced) throw error

    await assertReusable(input, raced, input.storage)
    return { publish: false, run: raced }
  }
}

async function persistRunInTransaction<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  tx: Storage,
  runId: string,
  execution: CreateExecutionInput,
  queuedAt: Date
): Promise<PersistedRun<TRun>> {
  const { primitive } = input

  const raced = await primitive.runs(tx).getById({ projectId: input.projectId, id: runId })
  if (raced) {
    await assertReusable(input, raced, tx)
    return { publish: false, run: raced }
  }

  if (input.joinQueuedRun) {
    const waiting = await primitive.oldestQueuedRun(tx)
    if (waiting && primitive.matches(waiting)) {
      return {
        publish: true,
        run: waiting,
        queuedAt: waiting.queuedAt,
        created: false,
        jobId: joinJobId(waiting),
      }
    }
  }

  await tx.executions.create(execution)
  const run = await primitive.queueRun(tx, { id: runId, executionId: execution.id, queuedAt })
  return { publish: true, run, queuedAt, created: true }
}

/**
 * The job a trigger publishes for the run it joins. The run's own job may be gone (a provider keeps
 * a settled job id, and ignores a new job under it), so a joining trigger brings a job that can
 * start the run. However many join, the run gets one, so a busy trigger costs nothing per event.
 */
function joinJobId(waiting: QueuedRun): string {
  return `${waiting.id}:join`
}

async function reuseRun<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  existing: TRun
): Promise<PersistedRun<TRun>> {
  await assertReusable(input, existing, input.storage)

  if (input.validateExistingRun && existing.status === "queued") {
    await requireExecution(input, existing)
    return { publish: true, run: existing, queuedAt: existing.queuedAt, created: false }
  }

  if (
    existing.status !== "failed" ||
    existing.error?.code !== "queue.enqueue_failed" ||
    !existing.error.retryable
  ) {
    return { publish: false, run: existing }
  }

  await requireExecution(input, existing)

  const queuedAt = new Date()
  const run = await input.primitive.requeueRun(input.storage, existing, queuedAt)
  return { publish: true, run, queuedAt, created: false }
}

async function assertReusable<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  run: TRun,
  storage: Storage
): Promise<void> {
  if (!input.primitive.matches(run)) {
    throw input.primitive.runError(
      `[Sixb] ${input.primitive.label} run '${run.id}' already exists with a different request payload.`
    )
  }

  await input.validateExistingRun?.(run, storage)
}

async function requireExecution<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  run: TRun
): Promise<void> {
  const execution = await input.storage.executions.getById({
    projectId: input.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw input.primitive.runError(
      `[Sixb] Execution '${run.executionId}' for ${input.primitive.label} run '${run.id}' was not found.`
    )
  }
}

async function publishRun<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>,
  persisted: Extract<PersistedRun<TRun>, { readonly publish: true }>
): Promise<TResult> {
  const { primitive } = input
  const jobId = persisted.jobId ?? persisted.run.id

  try {
    const job = await primitive.enqueue({
      id: jobId,
      runId: persisted.run.id,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
    if (!job || job.id !== jobId) {
      throw primitive.runError(
        `[Sixb] Queue did not acknowledge ${primitive.label} run '${persisted.run.id}'.`
      )
    }

    return primitive.result(persisted.run, {
      queuedAt: persisted.queuedAt,
      jobId: job.id,
      created: persisted.created,
    })
  } catch (error) {
    // Automatic consumers retain the batch and retry. Keep uncertain delivery queued:
    // a lost reply does not prove that the queue rejected the job.
    if (input.validateExistingRun) throw error

    await primitive.failPublication(
      persisted.run,
      createSixbError(
        "queue.enqueue_failed",
        `[Sixb] Could not enqueue ${primitive.label} run '${persisted.run.id}'.`,
        {
          cause: error,
          details: {
            ...primitive.failureDetails(persisted.run),
            runId: persisted.run.id,
            phase: "enqueue",
          },
        }
      ),
      error,
      new Date()
    )
    throw error
  }
}

/** Whether an execution is the one this automatic trigger would have created for its run. */
export function hasAutomaticRunProvenance(
  execution: ExecutionRecord | null,
  input: { readonly source: RunDispatchProvenance; readonly correlationId: string }
): boolean {
  return (
    execution !== null &&
    isDeepStrictEqual(execution.source, input.source) &&
    execution.correlationId === input.correlationId &&
    execution.requestedBy === undefined
  )
}

function createRunId<TRun extends QueuedRun, TResult>(
  input: DispatchQueuedRunInput<TRun, TResult>
): string {
  if (input.runId === undefined) return `run_${randomUUID()}`

  if (!input.runId.trim()) {
    throw input.primitive.requestError(`[Sixb] ${input.primitive.label} run id must not be empty`)
  }

  return input.runId
}
