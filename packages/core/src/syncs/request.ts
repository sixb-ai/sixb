import { randomUUID } from "node:crypto"
import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import { SyncValidationError } from "./errors"
import type { SyncDefinition } from "./types"

export interface SyncRunRequestOptions {
  /**
   * Identity of the run to create. Deduplicated when a worker claims the job, not here: two requests
   * carrying the same id enqueue two jobs, and the second `start()` loses to the unique run id and
   * no-ops. So one run happens, but this call cannot tell you whether it was yours.
   */
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
  /** When the job was enqueued. Not persisted — the run row records `startedAt` instead. */
  readonly queuedAt: string
  readonly jobId?: string
}

/**
 * Authorize and queue a sync run request.
 *
 * Operates on an already-resolved definition and the shared runtime context, so the HTTP route and
 * the runtime verb cannot drift apart.
 *
 * A sync run row is created by the worker that claims the job, not here — `SyncRunStatus` has no
 * `queued` member, unlike `WorkflowRunStatus`. So this reports "the request is accepted", where
 * `requestWorkflowRun` reports "the run exists" and can therefore return `created`. Aligning the two
 * means giving sync and pipeline runs a queued state across every storage provider, which is a
 * lifecycle change rather than a field; `created` can be added here afterwards without breaking
 * anyone, since nothing implements this result type.
 *
 * The storage precondition below is checked even though nothing here writes: accepting a request the
 * worker will refuse is worse than failing now.
 */
export async function requestSyncRun(
  runtime: SixbRuntimeContext,
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

  const runId = createSyncRunId(options.runId)
  const queuedAt = new Date().toISOString()
  const [job] = await queue.enqueue({
    projectId: runtime.projectId,
    jobs: [
      {
        type: "sync.run.requested",
        payload: {
          syncId: sync.id,
          runId,
          expectedLatestVersionId: options.expectedLatestVersionId,
          commitMessage: options.commitMessage,
        },
      },
    ],
  })

  return { syncId: sync.id, runId, queuedAt, jobId: job?.id }
}

function createSyncRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new SyncValidationError("[Sixb] Sync run id must not be empty")
    }
    return runId
  }

  return `run_${randomUUID()}`
}
