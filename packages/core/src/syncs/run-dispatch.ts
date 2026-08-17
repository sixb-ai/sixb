import { randomUUID } from "node:crypto"
import { reportRunFailure } from "../error-reporting/capability"
import { createSixbError, toSixbFailure } from "../errors/internal"
import type { SixbFailure } from "../errors/types"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type { CreateExecutionInput, Storage, SyncRunFailureCode, SyncRunRecord } from "../storage"
import { SYNC_RUN_FAILURE_CODES, SyncRunError } from "../storage"
import { SyncValidationError } from "./errors"
import type { SyncRunRequestOptions, SyncRunRequestResult } from "./request"
import type { SyncDefinition } from "./types"

export type AutomaticSyncExecutionSource =
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }

export interface AutomaticSyncRunDispatchInput extends SyncRunRequestOptions {
  readonly syncId: string
  readonly runId: string
  readonly source: AutomaticSyncExecutionSource
  readonly correlationId: string
  readonly metadata?: Readonly<Record<string, string>>
}

export type SyncRunDispatchPort = RunDispatcher<AutomaticSyncRunDispatchInput, SyncRunRequestResult>

export interface SyncRunDispatcherDependencies {
  readonly id: string
  readonly definitions: Pick<SixbDefinitions, "syncs">
  readonly storage: Storage
  readonly queues: Pick<Queues, "syncRuns">
}

interface DispatchSyncRunInput extends SyncRunRequestOptions {
  readonly errorReporterHost: object
  readonly projectId: string
  readonly sync: SyncDefinition
  readonly storage: Storage
  readonly queue: Queues["syncRuns"]
  readonly metadata?: Readonly<Record<string, string>>
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
  readonly validateExistingRun?: (run: SyncRunRecord, storage: Storage) => Promise<void>
}

type PersistedSyncRun =
  | { readonly publish: false; readonly run: SyncRunRecord }
  | {
      readonly publish: true
      readonly run: SyncRunRecord
      readonly execution: CreateExecutionInput
      readonly queuedAt: Date
      readonly created: boolean
    }

/** Core-owned durable dispatch boundary used by automatic Sync triggers. */
export class SyncRunDispatcher implements SyncRunDispatchPort {
  constructor(private readonly dependencies: SyncRunDispatcherDependencies) {}

  async dispatch(input: AutomaticSyncRunDispatchInput): Promise<SyncRunRequestResult> {
    assertAutomaticDispatchInput(input)
    const sync = this.dependencies.definitions.syncs.getById(input.syncId)
    if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)

    return dispatchSyncRun({
      errorReporterHost: this.dependencies,
      projectId: this.dependencies.id,
      sync,
      storage: this.dependencies.storage,
      queue: this.dependencies.queues.syncRuns,
      runId: input.runId,
      expectedLatestVersionId: input.expectedLatestVersionId,
      commitMessage: input.commitMessage,
      metadata: input.metadata,
      validateExistingRun: (run, storage) =>
        assertAutomaticExecutionIdentity(storage, this.dependencies.id, input, run),
      createExecution: async (executionId, runId) =>
        createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "sync", id: sync.id, runId },
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

/** Persist a Sync execution and queued run before publishing its queue job. */
export async function dispatchSyncRun(input: DispatchSyncRunInput): Promise<SyncRunRequestResult> {
  const runId = createSyncRunId(input.runId)
  const persisted = await persistSyncRun(input, runId)
  if (!persisted.publish) return existingSyncRunResult(persisted.run)
  return publishSyncRun(input, persisted)
}

async function persistSyncRun(
  input: DispatchSyncRunInput,
  runId: string
): Promise<PersistedSyncRun> {
  const syncRuns = requireSyncRunStorage(input.storage)
  const existing = await syncRuns.getById({ projectId: input.projectId, id: runId })
  if (existing) return reuseSyncRun(input, existing)

  const execution = await input.createExecution(`exec_${randomUUID()}`, runId)
  const queuedAt = new Date()
  try {
    return await input.storage.transaction(
      async (tx): Promise<PersistedSyncRun> => {
        const transactionalRuns = requireSyncRunStorage(tx)
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
          syncId: input.sync.id,
          datasetId: input.sync.target.dataset.id,
          mode: input.sync.config.mode,
          queuedAt,
          expectedLatestVersionId: input.expectedLatestVersionId,
          commitMessage: input.commitMessage,
        })
        return { publish: true, run, execution, queuedAt, created: true }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!(error instanceof SyncRunError)) throw error
    const raced = await syncRuns.getById({ projectId: input.projectId, id: runId })
    if (!raced) throw error
    assertExistingRunMatchesRequest(raced, input)
    await input.validateExistingRun?.(raced, input.storage)
    return { publish: false, run: raced }
  }
}

async function reuseSyncRun(
  input: DispatchSyncRunInput,
  existing: SyncRunRecord
): Promise<PersistedSyncRun> {
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
    throw new SyncRunError(
      `[Sixb] Execution '${existing.executionId}' for Sync run '${existing.id}' was not found.`
    )
  }

  const queuedAt = new Date()
  const run = await requireSyncRunStorage(input.storage).queue({
    projectId: input.projectId,
    id: existing.id,
    executionId: existing.executionId,
    syncId: existing.syncId,
    datasetId: existing.datasetId,
    mode: existing.mode,
    queuedAt,
    expectedLatestVersionId: existing.expectedLatestVersionId,
    commitMessage: existing.commitMessage,
  })
  return { publish: true, run, execution, queuedAt, created: false }
}

async function publishSyncRun(
  input: DispatchSyncRunInput,
  persisted: Extract<PersistedSyncRun, { readonly publish: true }>
): Promise<SyncRunRequestResult> {
  try {
    const [job] = await input.queue.enqueue({
      projectId: input.projectId,
      jobs: [
        {
          id: persisted.run.id,
          type: "sync.run.requested",
          payload: { runId: persisted.run.id },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      ],
    })
    return {
      syncId: persisted.run.syncId,
      runId: persisted.run.id,
      queuedAt: persisted.queuedAt.toISOString(),
      ...(job?.id ? { jobId: job.id } : {}),
      created: persisted.created,
    }
  } catch (error) {
    const failedAt = new Date()
    const failure = toEnqueueFailure(error, persisted.run, failedAt)
    const failed = await requireSyncRunStorage(input.storage).finish({
      projectId: input.projectId,
      id: persisted.run.id,
      status: "failed",
      finishedAt: failedAt,
      error: failure,
    })
    reportRunFailure(input.errorReporterHost, error, {
      projectId: input.projectId,
      runKind: "sync",
      run: { runId: failed.id, syncId: failed.syncId },
      failure,
    })
    throw error
  }
}

function assertExistingRunMatchesRequest(
  existing: SyncRunRecord,
  input: Pick<DispatchSyncRunInput, "sync" | "expectedLatestVersionId" | "commitMessage">
): void {
  if (
    existing.syncId !== input.sync.id ||
    existing.datasetId !== input.sync.target.dataset.id ||
    existing.mode !== input.sync.config.mode ||
    existing.expectedLatestVersionId !== input.expectedLatestVersionId ||
    existing.commitMessage !== input.commitMessage
  ) {
    throw new SyncRunError(
      `[Sixb] Sync run '${existing.id}' already exists with a different request payload.`
    )
  }
}

function existingSyncRunResult(existing: SyncRunRecord): SyncRunRequestResult {
  return {
    syncId: existing.syncId,
    runId: existing.id,
    queuedAt: existing.queuedAt.toISOString(),
    created: false,
  }
}

function requireSyncRunStorage(storage: Storage): NonNullable<Storage["syncRuns"]> {
  if (!storage.syncRuns) throw new SyncValidationError("[Sixb] Sync run storage is not configured.")
  return storage.syncRuns
}

function createSyncRunId(runId: string | undefined): string {
  if (runId === undefined) return `run_${randomUUID()}`
  if (!runId.trim()) throw new SyncValidationError("[Sixb] Sync run id must not be empty")
  return runId
}

function assertAutomaticDispatchInput(input: AutomaticSyncRunDispatchInput): void {
  assertNonBlank(input.syncId, "Sync id")
  assertNonBlank(input.runId, "Sync run id")
  assertNonBlank(input.source.eventId, "Sync source event id")
  assertNonBlank(input.correlationId, "Sync correlation id")
}

async function assertAutomaticExecutionIdentity(
  storage: Storage,
  projectId: string,
  input: AutomaticSyncRunDispatchInput,
  run: SyncRunRecord
): Promise<void> {
  const execution = await storage.executions.getById({ projectId, id: run.executionId })
  if (
    !execution ||
    execution.source.type !== input.source.type ||
    execution.source.eventId !== input.source.eventId ||
    execution.correlationId !== input.correlationId ||
    execution.requestedBy !== undefined
  ) {
    throw new SyncValidationError(
      `[Sixb] Sync run '${run.id}' already exists with different automatic provenance.`
    )
  }
}

function toEnqueueFailure(
  error: unknown,
  run: SyncRunRecord,
  at: Date
): SixbFailure<SyncRunFailureCode> {
  const enqueueError = createSixbError(
    "queue.enqueue_failed",
    `[Sixb] Could not enqueue Sync run '${run.id}'.`,
    {
      cause: error,
      details: { syncId: run.syncId, runId: run.id, phase: "enqueue" },
    }
  )
  return toSixbFailure(enqueueError, { allowedCodes: SYNC_RUN_FAILURE_CODES, at })
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new SyncValidationError(`[Sixb] ${label} must not be empty.`)
}
