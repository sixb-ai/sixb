import type { DomainEventLog, Queues, SixbDefinitions, Storage } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ActionRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import { ACTION_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerHost extends PrimitiveExecutionHost {
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly queues: Queues
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "actions">
}

export interface ActionWorkerOptions {
  readonly leaseMs?: number
  readonly idlePollMs?: number
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
      idlePollMs: options.idlePollMs,
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

    const actionRuns = this.host.storage.actionRuns
    if (!actionRuns) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbActionWorker] Action workers require storage.actionRuns support.",
        { details: { runId: job.payload.runId } }
      )
    }
    const run = await actionRuns.getById({ projectId: this.host.id, id: job.payload.runId })
    if (!run) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbActionWorker] Action run '${job.payload.runId}' was not found.`,
        { details: { runId: job.payload.runId } }
      )
    }

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbActionWorker] Action run '${run.id}' references missing execution '${run.executionId}'.`,
        {
          details: {
            actionId: run.actionId,
            runId: run.id,
            executionId: run.executionId,
          },
        }
      )
    }

    const actionJob: ActionJob = { id: run.id, actionId: run.actionId }
    const execution = bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: {
        kind: "action",
        id: run.actionId,
        runId: run.id,
      },
    })
    const context = buildActionContext(this.host, execution)

    const result = await runActionJob({
      runtime: context,
      job: actionJob,
      run,
      signal,
      attempt: job.attempt,
    })

    if ("skipped" in result) {
      return
    }

    await emitActionTerminalEvent(this.host, result, durableExecution.correlationId)
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

function buildActionContext(
  host: ActionWorkerHost,
  execution: ReturnType<typeof bindDurablePrimitiveExecution>
): ActionWorkerContext {
  const actionRunsStorage = host.storage.actionRuns
  if (!actionRunsStorage) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbActionWorker] Action workers require storage.actionRuns support."
    )
  }
  const sixb = {
    objects: execution.sixb.objects,
    actions: execution.sixb.actions,
    connector: execution.sixb.connector,
    blobs: execution.sixb.blobs,
  }
  return {
    id: host.id,
    errorReporterHost: host,
    events: host.events,
    logging: host.logging,
    storage: host.storage,
    actionRunsStorage,
    ontologyMutations: execution.ontologyMutations,
    sixb,
    actions: host.definitions.actions,
  }
}
