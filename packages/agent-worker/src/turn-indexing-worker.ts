import { type AgentTurnIndexing, AgentTurnIndexingDeferred } from "@sixb/core/internal/agents"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, TurnIndexingQueueJob } from "@sixb/core/queues"
import type { AgentWorkerHost } from "./types"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

/** How many conversations one agent worker indexes at once, beside its turns. */
export const TURN_INDEXING_CONCURRENCY = 2

/** Before indexing a conversation again after storage failed to record why it stopped. */
const RETRY_MS = 60_000

/**
 * Separate lane: an embedding model's latency, or a back-fill of every conversation, never takes
 * the slot a turn waits for. The agent worker starts and stops it with its own.
 */
export class TurnIndexingWorker extends QueueWorker<TurnIndexingQueueJob, typeof FAILURE_CODES> {
  private readonly indexing: AgentTurnIndexing

  constructor(host: AgentWorkerHost, indexing: AgentTurnIndexing) {
    super({
      projectId: host.id,
      queue: host.queues.turnIndexing,
      failureCodes: FAILURE_CODES,
      workerId: `turn-indexing-${host.id}`,
      claimLimit: TURN_INDEXING_CONCURRENCY,
    })

    this.indexing = indexing
  }

  protected execute(claimed: ClaimedQueueJob<TurnIndexingQueueJob>, signal: AbortSignal) {
    const { job } = claimed
    return this.indexing.index(job.payload.threadId, job.attempt, signal)
  }

  /** The thread records how long it waits: the project's AI limit, or a failure's backoff. */
  protected override onExecutionError(
    claimed: ClaimedQueueJob<TurnIndexingQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    const { threadId } = claimed.job.payload

    if (error instanceof AgentTurnIndexingDeferred) {
      if (error.cause !== undefined) {
        console.warn(
          `[SixbAgentWorker] Could not index Agent thread '${threadId}'; retrying later.`,
          error.cause
        )
      }
      return { kind: "retry", availableAt: error.availableAt }
    }

    console.warn(
      `[SixbAgentWorker] Could not index Agent thread '${threadId}'; retrying later.`,
      error
    )
    return { kind: "retry", availableAt: new Date(Date.now() + RETRY_MS).toISOString() }
  }

  protected override onAbortError(): QueueWorkerFailureDecision {
    return { kind: "retry" }
  }
}
