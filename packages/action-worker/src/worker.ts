import type { DomainEventLog, Queues, SixbDefinitions, Storage } from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
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
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "actions">
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

    const actions = host.definitions.actions.list()
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

    const actionRuns = this.host.storage.actionRuns
    if (!actionRuns) {
      throw new ActionWorkerError("Action workers require storage.actionRuns support.")
    }
    const run = await actionRuns.getById({ projectId: this.host.id, id: job.payload.runId })
    if (!run) {
      throw new ActionWorkerError(`Action run '${job.payload.runId}' was not found.`)
    }

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw new ActionWorkerError(
        `Action run '${run.id}' references missing execution '${run.executionId}'.`
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
    logging: host.logging,
    storage: host.storage,
    actionRunsStorage,
    ontologyMutations: execution.ontologyMutations,
    sixb,
    actions: host.definitions.actions,
  }
}
