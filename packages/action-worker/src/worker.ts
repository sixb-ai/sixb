import type { Queues } from "@sixb/core"
import type { ActionRunHost, ActionRunResult } from "@sixb/core/internal/actions"
import { executeActionRun } from "@sixb/core/internal/actions"
import { createSixbError } from "@sixb/core/internal/errors"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ActionRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import { ACTION_RUN_FAILURE_CODES } from "@sixb/core/storage"

export interface ActionWorkerHost extends ActionRunHost {
  readonly queues: Queues
}

export interface ActionWorkerOptions {
  readonly leaseMs?: number
}

export class ActionWorker extends QueueWorker<
  ActionRunRequestedQueueJob,
  typeof ACTION_RUN_FAILURE_CODES
> {
  private readonly host: ActionWorkerHost
  private readonly idleWithoutDefinitions: boolean

  constructor(host: ActionWorkerHost, options: ActionWorkerOptions = {}) {
    super({
      projectId: host.id,
      queue: host.queues.actions,
      failureCodes: ACTION_RUN_FAILURE_CODES,
      workerId: `action-worker-${host.id}`,
      claimLimit: 1,
      leaseMs: options.leaseMs,
    })

    const actions = host.definitions.actions.list()
    if (actions.length === 0) {
      console.log("[SixbActionWorker] No action definitions registered; worker will idle.")
    } else if (!host.storage.actionRuns) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbActionWorker] Action workers require storage.actionRuns support."
      )
    }

    this.host = host
    this.idleWithoutDefinitions = actions.length === 0
  }

  protected override async run(signal: AbortSignal): Promise<void> {
    if (!this.idleWithoutDefinitions) {
      await super.run(signal)
      return
    }

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  protected async execute(
    claimed: ClaimedQueueJob<ActionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    if (this.idleWithoutDefinitions) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbActionWorker] No action definitions are registered.",
        { details: { runId: claimed.job.payload.runId } }
      )
    }

    const { job } = claimed
    if (job.type !== "action.run.requested") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbActionWorker] Unsupported action job type '${job.type}'.`,
        { details: { runId: job.payload.runId } }
      )
    }

    const { result, correlationId } = await executeActionRun(this.host, {
      runId: job.payload.runId,
      signal,
      attempt: job.attempt,
    })
    if ("skipped" in result) {
      return
    }

    await emitActionTerminalEvent(this.host, result, correlationId)
  }

  protected override async onExecutionError(
    _claimed: ClaimedQueueJob<ActionRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }

  protected override async onAbortError(
    _claimed: ClaimedQueueJob<ActionRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }
}

async function emitActionTerminalEvent(
  host: ActionWorkerHost,
  result: Exclude<ActionRunResult, { skipped: true }>,
  correlationId: string
): Promise<void> {
  const finishedAt = result.finishedAt.toISOString()

  await host.events.emit(
    {
      events:
        result.status === "succeeded"
          ? [
              {
                type: "action.completed",
                idempotencyKey: `action.completed:${result.id}`,
                payload: {
                  actionId: result.actionId,
                  runId: result.id,
                  subject: result.subject,
                  finishedAt,
                },
              },
            ]
          : [
              {
                type: "action.failed",
                idempotencyKey: `action.failed:${result.id}`,
                payload: {
                  actionId: result.actionId,
                  runId: result.id,
                  subject: result.subject,
                  error: result.error,
                  finishedAt,
                },
              },
            ],
      correlationId,
    },
    { source: "SixbActionWorker" }
  )
}
