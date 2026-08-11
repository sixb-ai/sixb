import type { ActionsRuntime, DomainEventLog, Queues, Storage } from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import {
  bindPrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ActionRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import { ActionWorkerError } from "./errors"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerHost extends PrimitiveExecutionHost {
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly queues: Queues
  readonly logs?: LogsRuntime
  readonly actions: Pick<ActionsRuntime, "list" | "getById" | "listForType">
}

export interface ActionWorkerOptions {
  readonly leaseMs?: number
  readonly idlePollMs?: number
}

export class ActionWorker extends QueueWorker<ActionRunRequestedQueueJob> {
  private readonly host: ActionWorkerHost
  private readonly idleWithoutDefinitions: boolean

  constructor(host: ActionWorkerHost, options: ActionWorkerOptions = {}) {
    super({
      projectId: host.id,
      queue: host.queues.actions,
      workerId: `action-worker-${host.id}`,
      claimLimit: 1,
      leaseMs: options.leaseMs,
      idlePollMs: options.idlePollMs,
    })

    const actions = host.actions.list()
    if (actions.length === 0) {
      console.log("[SixbActionWorker] No action definitions registered; worker will idle.")
    } else if (!host.storage.actionRuns) {
      throw new ActionWorkerError("Action workers require storage.actionRuns support.")
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
      throw new ActionWorkerError("No action definitions are registered.")
    }

    const { job } = claimed
    if (job.type !== "action.run.requested") {
      throw new ActionWorkerError(`Unsupported action job type '${job.type}'.`)
    }

    const actionJob: ActionJob = {
      id: job.payload.runId,
      actionId: job.payload.actionId,
    }

    const execution = bindPrimitiveExecution(this.host, {
      primitive: {
        kind: "action",
        id: actionJob.actionId,
        runId: actionJob.id,
      },
      source: { type: "queue", queue: "actions", jobId: job.id },
    })
    const context = buildActionContext(this.host, execution)

    const result = await runActionJob({
      runtime: context,
      job: actionJob,
      signal,
      attempt: job.attempt,
    })

    if ("skipped" in result) {
      return
    }

    await emitActionTerminalEvent(this.host, result)
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
  result: Exclude<ActionRunResult, { skipped: true }>
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
    },
    { source: "SixbActionWorker" }
  )
}

function buildActionContext(
  host: ActionWorkerHost,
  execution: ReturnType<typeof bindPrimitiveExecution>
): ActionWorkerContext {
  const actionRunsStorage = host.storage.actionRuns
  if (!actionRunsStorage) {
    throw new ActionWorkerError("Action workers require storage.actionRuns support.")
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
    logs: host.logs,
    storage: host.storage,
    actionRunsStorage,
    ontologyMutations: execution.ontologyMutations,
    sixb,
    actions: host.actions,
  }
}
