import { reportRunFailure } from "../error-reporting/capability"
import { toSixbFailure } from "../errors/internal"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type { CreateExecutionInput, Storage, SyncRunRecord } from "../storage"
import { SYNC_RUN_FAILURE_CODES, SyncRunError } from "../storage"
import {
  dispatchQueuedRun,
  hasAutomaticRunProvenance,
  type QueuedRunPrimitive,
  type QueuedRunStore,
  type RunPublication,
} from "../workers/queued-run-dispatch"
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
  /** A trigger, not a caller (see `dispatchQueuedRun`). */
  readonly automatic?: boolean
  /** Return a matching run of this Sync that has not started yet instead of queueing another one. */
  readonly joinQueuedRun?: boolean
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
      automatic: true,
      validateExistingRun: (run, storage) =>
        assertAutomaticExecutionIdentity(storage, this.dependencies.id, input, run),
      joinQueuedRun: true,
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
  return dispatchQueuedRun({
    primitive: syncRunPrimitive(input),
    projectId: input.projectId,
    storage: input.storage,
    runId: input.runId,
    metadata: input.metadata,
    createExecution: input.createExecution,
    validateExistingRun: input.validateExistingRun,
    automatic: input.automatic,
    joinQueuedRun: input.joinQueuedRun,
  })
}

function syncRunPrimitive(
  input: DispatchSyncRunInput
): QueuedRunPrimitive<SyncRunRecord, SyncRunRequestResult> {
  const { projectId } = input

  return {
    label: "Sync",
    failureDetails: (run) => ({ syncId: run.syncId }),

    store: (storage) => syncRunStore(input, requireSyncRunStorage(storage)),
    matches: (run) => runMatchesRequest(run, input),

    async enqueue(job) {
      const [enqueued] = await input.queue.enqueue({
        projectId,
        jobs: [
          {
            id: job.id,
            type: "sync.run.requested",
            payload: { runId: job.runId },
            ...(job.metadata === undefined ? {} : { metadata: job.metadata }),
          },
        ],
      })
      return enqueued
    },

    async failPublication(run, failure, cause, at) {
      const syncFailure = toSixbFailure(failure, { allowedCodes: SYNC_RUN_FAILURE_CODES, at })
      const failed = await requireSyncRunStorage(input.storage).finish({
        projectId,
        id: run.id,
        status: "failed",
        finishedAt: at,
        error: syncFailure,
      })
      reportRunFailure(input.errorReporterHost, cause, {
        projectId,
        runKind: "sync",
        run: { runId: failed.id, syncId: failed.syncId },
        failure: syncFailure,
      })
    },

    result: toRequestResult,

    RunError: SyncRunError,
    RequestError: SyncValidationError,
  }
}

function syncRunStore(
  input: DispatchSyncRunInput,
  runs: NonNullable<Storage["syncRuns"]>
): QueuedRunStore<SyncRunRecord> {
  const { projectId, sync } = input

  return {
    getById: (params) => runs.getById(params),

    async oldestQueued() {
      const { runs: queued } = await runs.list({
        projectId,
        syncId: sync.id,
        statuses: ["queued"],
        order: "asc",
        limit: 1,
      })

      return queued[0]
    },

    queue: (run) =>
      runs.queue({
        projectId,
        id: run.id,
        executionId: run.executionId,
        syncId: sync.id,
        datasetId: sync.target.dataset.id,
        mode: sync.config.mode,
        queuedAt: run.queuedAt,
        expectedLatestVersionId: input.expectedLatestVersionId,
        commitMessage: input.commitMessage,
      }),

    requeue: (run, queuedAt) =>
      runs.queue({
        projectId,
        id: run.id,
        executionId: run.executionId,
        syncId: run.syncId,
        datasetId: run.datasetId,
        mode: run.mode,
        queuedAt,
        expectedLatestVersionId: run.expectedLatestVersionId,
        commitMessage: run.commitMessage,
      }),
  }
}

/**
 * A run that has not started reads its source when it starts, so it already covers a trigger that
 * arrives now. One queued with another request payload is not joined.
 */
function runMatchesRequest(
  existing: SyncRunRecord,
  input: Pick<DispatchSyncRunInput, "sync" | "expectedLatestVersionId" | "commitMessage">
): boolean {
  return (
    existing.syncId === input.sync.id &&
    existing.datasetId === input.sync.target.dataset.id &&
    existing.mode === input.sync.config.mode &&
    existing.expectedLatestVersionId === input.expectedLatestVersionId &&
    existing.commitMessage === input.commitMessage
  )
}

function toRequestResult(run: SyncRunRecord, publication?: RunPublication): SyncRunRequestResult {
  return {
    syncId: run.syncId,
    runId: run.id,
    queuedAt: (publication?.queuedAt ?? run.queuedAt).toISOString(),
    ...(publication ? { jobId: publication.jobId } : {}),
    created: publication?.created ?? false,
  }
}

function requireSyncRunStorage(storage: Storage): NonNullable<Storage["syncRuns"]> {
  if (!storage.syncRuns) throw new SyncValidationError("[Sixb] Sync run storage is not configured.")
  return storage.syncRuns
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
  if (!hasAutomaticRunProvenance(execution, input)) {
    throw new SyncValidationError(
      `[Sixb] Sync run '${run.id}' already exists with different automatic provenance.`
    )
  }
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new SyncValidationError(`[Sixb] ${label} must not be empty.`)
}
