import { isOAuthConnectorDefinition } from "../connectors"
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
import { findSyncConnections } from "./connections"
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
  /**
   * The connection the triggering event is about. A sync of that connection's connector runs for
   * it alone; any other sync runs for every connection as usual.
   */
  readonly connection?: { readonly id: string; readonly connectorId: string }
}

/** A sync of a static connector queues one run; a sync of an OAuth connector one per connection. */
export type SyncRunDispatchPort = RunDispatcher<
  AutomaticSyncRunDispatchInput,
  readonly SyncRunRequestResult[]
>

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
  /** The connection this run reads, on a sync of an OAuth connector. */
  readonly connectionId?: string
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

  async dispatch(input: AutomaticSyncRunDispatchInput): Promise<readonly SyncRunRequestResult[]> {
    assertAutomaticDispatchInput(input)
    const sync = this.dependencies.definitions.syncs.getById(input.syncId)
    if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)

    if (!isOAuthConnectorDefinition(sync.connector)) {
      return [await this.dispatchRun(sync, input, input.runId)]
    }

    const connectionIds =
      input.connection?.connectorId === sync.connector.id
        ? [input.connection.id]
        : await listSyncConnectionIds(this.dependencies, sync)

    // Each run id comes from the trigger's and the connection's, so a redelivered trigger, or one
    // retried after some of its runs were queued, queues nothing twice.
    const results: SyncRunRequestResult[] = []
    for (const connectionId of connectionIds) {
      results.push(
        await this.dispatchRun(sync, input, `${input.runId}:${connectionId}`, connectionId)
      )
    }
    return results
  }

  private dispatchRun(
    sync: SyncDefinition,
    input: AutomaticSyncRunDispatchInput,
    runId: string,
    connectionId?: string
  ): Promise<SyncRunRequestResult> {
    return dispatchSyncRun({
      errorReporterHost: this.dependencies,
      projectId: this.dependencies.id,
      sync,
      ...(connectionId === undefined ? {} : { connectionId }),
      storage: this.dependencies.storage,
      queue: this.dependencies.queues.syncRuns,
      runId,
      expectedLatestVersionId: input.expectedLatestVersionId,
      commitMessage: input.commitMessage,
      metadata: input.metadata,
      automatic: true,
      validateExistingRun: (run, storage) =>
        assertAutomaticExecutionIdentity(storage, this.dependencies.id, input, run),
      joinQueuedRun: true,
      createExecution: async (executionId, queuedRunId) =>
        createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "sync", id: sync.id, runId: queuedRunId },
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
        connectionId: input.connectionId ?? null,
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
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
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
        ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
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
 * arrives now. One queued for another connection, or with another request payload, is not joined.
 */
function runMatchesRequest(
  existing: SyncRunRecord,
  input: Pick<
    DispatchSyncRunInput,
    "sync" | "connectionId" | "expectedLatestVersionId" | "commitMessage"
  >
): boolean {
  return (
    existing.syncId === input.sync.id &&
    existing.connectionId === input.connectionId &&
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
    ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
    queuedAt: (publication?.queuedAt ?? run.queuedAt).toISOString(),
    ...(publication ? { jobId: publication.jobId } : {}),
    created: publication?.created ?? false,
  }
}

async function listSyncConnectionIds(
  host: object,
  sync: SyncDefinition
): Promise<readonly string[]> {
  if (!isOAuthConnectorDefinition(sync.connector)) return []
  const connections = findSyncConnections(host)
  if (!connections) {
    throw new SyncValidationError(
      `[Sixb] Sync '${sync.id}' reads OAuth connector '${sync.connector.id}', whose connections this host cannot list.`
    )
  }
  return (await connections.list(sync.connector)).map((connection) => connection.id)
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
