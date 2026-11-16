import { assertAuthorized, isRuntimeAllowed } from "../authorization"
import { type ConnectorConnectionMetadata, isOAuthConnectorDefinition } from "../connectors"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SyncConnections } from "./connections"
import { SyncValidationError } from "./errors"
import { dispatchSyncRun } from "./run-dispatch"
import type { SyncDefinition } from "./types"

export interface SyncRunRequestOptions {
  /** Stable identity used to make dispatch idempotent. */
  readonly runId?: string
  /** Optimistic concurrency guard: fail the run if the dataset moved past this version. */
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

export interface RequestSyncRunOptions extends SyncRunRequestOptions {
  /**
   * The one connection to run, on a sync of an OAuth connector. Without it, the request runs every
   * connection the caller may run.
   */
  readonly connectionId?: string
}

export interface RequestSyncRunInput extends RequestSyncRunOptions {
  readonly syncId: string
}

export interface SyncRunRequestResult {
  readonly syncId: string
  readonly runId: string
  /** The connection the run reads, on a sync of an OAuth connector. */
  readonly connectionId?: string
  /** Durable time at which the run entered the queue. */
  readonly queuedAt: string
  readonly jobId?: string
  readonly created: boolean
}

/** A static connector's sync queues one run; an OAuth connector's sync one per connection. */
export interface SyncRunRequestResults {
  readonly runs: readonly SyncRunRequestResult[]
}

/**
 * Authorize and queue a sync run request.
 *
 * Operates on an already-resolved definition and the shared runtime context, so the HTTP route and
 * the runtime verb cannot drift apart.
 *
 * The immutable child execution and queued run are persisted before queue publication.
 */
export async function requestSyncRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  sync: SyncDefinition,
  options: RequestSyncRunOptions = {},
  connections?: SyncConnections
): Promise<SyncRunRequestResults> {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "sync.run", syncId: sync.id })
  if (!runtime.storage.syncRuns) {
    throw new SyncValidationError("[Sixb] Sync run storage is not configured.")
  }

  const queue = runtime.queues.syncRuns
  if (!queue) {
    throw new SyncValidationError("[Sixb] Sync run queue is not configured.")
  }

  const { connectionId, ...request } = options
  const dispatch = (runId: string | undefined, connection?: string) =>
    dispatchSyncRun({
      errorReporterHost: runtime,
      projectId: runtime.projectId,
      sync,
      storage: runtime.storage,
      queue,
      ...request,
      ...(runId === undefined ? {} : { runId }),
      // A run that has not started reads its connection when it starts: a request that arrives
      // meanwhile, like a burst of a person's notifications, is already covered by it.
      ...(connection === undefined ? {} : { connectionId: connection, joinQueuedRun: true }),
      createExecution: async (executionId, queuedRunId) => {
        const caller = await ensureExecutionRecord(
          runtime.storage.executions,
          executionRecordInputFromRuntime({
            execution,
            runtimeAuthorization: runtime.runtimeAuthorization,
          })
        )
        return createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "sync", id: sync.id, runId: queuedRunId },
          origin: { type: "execution", parent: caller },
        })
      },
    })

  if (!isOAuthConnectorDefinition(sync.connector)) {
    if (connectionId !== undefined) {
      throw new SyncValidationError(
        `[Sixb] Sync '${sync.id}' reads static connector '${sync.connector.id}', which has no connections.`
      )
    }
    return { runs: [await dispatch(request.runId)] }
  }

  if (!connections) {
    throw new SyncValidationError(
      `[Sixb] Sync '${sync.id}' reads OAuth connector '${sync.connector.id}', whose connections this runtime cannot list.`
    )
  }
  const runnable = (await connections.list(sync.connector)).filter((connection) =>
    mayRequestConnectionRun(runtime, execution, connection)
  )

  if (connectionId !== undefined) {
    if (!runnable.some((connection) => connection.id === connectionId)) {
      throw new SyncValidationError(
        `[Sixb] Sync '${sync.id}' has no connection '${connectionId}' you can run.`
      )
    }
    return { runs: [await dispatch(request.runId, connectionId)] }
  }

  const runs: SyncRunRequestResult[] = []
  for (const connection of runnable) {
    const runId = request.runId === undefined ? undefined : `${request.runId}:${connection.id}`
    runs.push(await dispatch(runId, connection.id))
  }
  return { runs }
}

/**
 * Anyone may run the project's connections. A person's own connection is theirs to run, and the
 * connector's managers may run anyone's: a sync reads into rows its owner owns, as the schedule
 * would. A run no one requested runs them all.
 */
function mayRequestConnectionRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  connection: ConnectorConnectionMetadata
): boolean {
  const { owner } = connection
  const requester = execution.requestedBy
  if (owner.type !== "user" || requester === undefined) return true
  if (requester.type === "user" && requester.id === owner.id) return true
  return isRuntimeAllowed(runtime, {
    kind: "connector.manage",
    connectorId: connection.connectorId,
  })
}
