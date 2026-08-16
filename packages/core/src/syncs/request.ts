import { assertAuthorized } from "../authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
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

export interface RequestSyncRunInput extends SyncRunRequestOptions {
  readonly syncId: string
}

export interface SyncRunRequestResult {
  readonly syncId: string
  readonly runId: string
  /** Durable time at which the run entered the queue. */
  readonly queuedAt: string
  readonly jobId?: string
  readonly created: boolean
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
  options: SyncRunRequestOptions = {}
): Promise<SyncRunRequestResult> {
  assertAuthorized(runtime, { kind: "sync.run", syncId: sync.id })
  if (!runtime.storage.syncRuns) {
    throw new SyncValidationError("[Sixb] Sync run storage is not configured.")
  }

  const queue = runtime.queues.syncRuns
  if (!queue) {
    throw new SyncValidationError("[Sixb] Sync run queue is not configured.")
  }

  return dispatchSyncRun({
    errorReporterHost: runtime,
    projectId: runtime.projectId,
    sync,
    storage: runtime.storage,
    queue,
    ...options,
    createExecution: async (executionId, runId) => {
      const caller = await ensureExecutionRecord(
        runtime.storage.executions,
        executionRecordInputFromRuntime({
          execution,
          runtimeAuthorization: runtime.runtimeAuthorization,
        })
      )
      return createPrimitiveExecutionRecord({
        id: executionId,
        primitive: { kind: "sync", id: sync.id, runId },
        origin: { type: "execution", parent: caller },
      })
    },
  })
}
