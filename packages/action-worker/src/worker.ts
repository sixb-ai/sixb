import type { ActionDefinition, Queues, Storage } from "@sixb/core"
import type { EventsRuntime } from "@sixb/core/internal/events"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ActionRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import { ActionWorkerError } from "./errors"
import { runActionJob } from "./run-action-job"
import type {
  ActionJob,
  ActionRunResult,
  ActionWorkerContext,
  ActionWorkerSixbFacade,
} from "./types"

export interface ActionWorkerSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly logs?: LogsRuntime
  readonly storage: Storage
  readonly queues: Queues
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
}

export interface ActionWorkerOptions {
  readonly leaseMs?: number
  readonly idlePollMs?: number
}

export class ActionWorker extends QueueWorker<ActionRunRequestedQueueJob> {
  private readonly context: ActionWorkerContext | null
  private readonly sixb: ActionWorkerSixb
  private readonly idleWithoutDefinitions: boolean

  constructor(sixb: ActionWorkerSixb, options: ActionWorkerOptions = {}) {
    super({
      projectId: sixb.id,
      queue: sixb.queues.actions,
      workerId: `action-worker-${sixb.id}`,
      claimLimit: 1,
      leaseMs: options.leaseMs,
      idlePollMs: options.idlePollMs,
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
    throw new ActionWorkerError("Action workers require storage.actionRuns support.")
  }
  assertActionWorkerSixbFacade(sixb)

  return {
    id: sixb.id,
    events: sixb.events,
    logs: sixb.logs,
    storage: sixb.storage,
    actionRunsStorage,
    sixb,
    getActionById(actionId) {
      return sixb.getActionById(actionId)
    },
  }
}

const requiredFacadeMethods = [
  "connector",
  "getActionsForType",
  "getPrimaryPropertyId",
  "getValueTypesById",
  "isValidLinkTarget",
  "objects",
  "resolveObjectType",
] as const satisfies readonly (keyof ActionWorkerSixbFacade)[]

function assertActionWorkerSixbFacade(
  sixb: ActionWorkerSixb
): asserts sixb is ActionWorkerSixb & ActionWorkerSixbFacade {
  const candidate = sixb as Partial<Record<(typeof requiredFacadeMethods)[number], unknown>>
  for (const method of requiredFacadeMethods) {
    if (typeof candidate[method] !== "function") {
      throw new ActionWorkerError(`Action worker runtime is missing sixb.${method}(...).`)
    }
  }

  const blobStorage = (sixb as { readonly blobStorage?: Record<string, unknown> }).blobStorage
  if (
    !blobStorage ||
    typeof blobStorage.put !== "function" ||
    typeof blobStorage.open !== "function" ||
    typeof blobStorage.stat !== "function"
  ) {
    throw new ActionWorkerError("Action worker runtime is missing sixb.blobStorage support.")
  }
}
