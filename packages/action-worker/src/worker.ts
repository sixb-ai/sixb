import type {
  ActionDefinition,
  ActionRunRequestedQueueJob,
  ClaimedQueueJob,
  EventsRuntime,
  OntologySource,
  Queues,
  QueueWorkerFailureDecision,
  Sixb,
  Storage,
} from "@sixb/core"
import { QueueWorker } from "@sixb/core"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
}

export interface ActionWorkerOptions {
  readonly maxConcurrency?: number
}

const DEFAULT_MAX_CONCURRENCY = 16

export class ActionWorker extends QueueWorker<ActionRunRequestedQueueJob> {
  private readonly context: ActionWorkerContext | null
  private readonly sixb: ActionWorkerSixb
  private readonly idleWithoutDefinitions: boolean

  constructor(sixb: ActionWorkerSixb, options: ActionWorkerOptions = {}) {
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    if (maxConcurrency <= 0) {
      throw new Error("[SixbActionWorker] maxConcurrency must be greater than 0.")
    }

    super({
      projectId: sixb.id,
      queue: sixb.queues.actions,
      workerId: `action-worker-${sixb.id}`,
      claimLimit: maxConcurrency,
    })

    const actions = sixb.getActionDefinitions()
    if (actions.length === 0) {
      console.log("[SixbActionWorker] No action definitions registered; worker will idle.")
    }

    this.context = actions.length > 0 ? buildActionContext(sixb) : null
    this.sixb = sixb
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
    const context = this.context
    if (!context) {
      throw new Error("[SixbActionWorker] No action definitions are registered.")
    }

    const { job } = claimed
    if (job.type !== "action.run.requested") {
      throw new Error(`[SixbActionWorker] Unsupported action job type '${job.type}'.`)
    }

    const actionJob: ActionJob = {
      id: job.payload.runId,
      actionId: job.payload.actionId,
    }

    const result = await runActionJob({
      runtime: context,
      job: actionJob,
      signal,
    })

    if ("skipped" in result) {
      return
    }

    await emitActionTerminalEvent(this.sixb, result)
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
  sixb: ActionWorkerSixb,
  result: Exclude<ActionRunResult, { skipped: true }>
): Promise<void> {
  try {
    const finishedAt = result.finishedAt.toISOString()

    if (result.status === "succeeded") {
      await sixb.events.append({
        events: [
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
        ],
      })
      return
    }

    await sixb.events.append({
      events: [
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
    })
  } catch (error) {
    console.error("[SixbActionWorker] Failed to emit action terminal event:", error)
  }
}

function buildActionContext(sixb: ActionWorkerSixb): ActionWorkerContext {
  const actionRunsStorage = sixb.storage.actionRuns
  if (!actionRunsStorage) {
    throw new Error("[SixbActionWorker] Action workers require storage.actionRuns support.")
  }

  return {
    id: sixb.id,
    events: sixb.events,
    storage: sixb.storage,
    actionRunsStorage,
    sixb: sixb as unknown as Sixb<readonly OntologySource[]>,
    getActionById(actionId) {
      return sixb.getActionById(actionId)
    },
  }
}
