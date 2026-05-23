import type {
  ActionDefinition,
  EventsRuntime,
  OntologySource,
  Sixb,
  Storage,
  StoredActionRequestedEvent,
} from "@sixb/core"
import { Worker } from "@sixb/core"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: Storage
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
}

export interface ActionWorkerOptions {
  readonly maxConcurrency?: number
}

const DEFAULT_MAX_CONCURRENCY = 16

export class ActionWorker extends Worker {
  private readonly context: ActionWorkerContext | null
  private readonly sixb: ActionWorkerSixb
  private readonly actionIds: ReadonlySet<string>
  private readonly maxConcurrency: number

  constructor(sixb: ActionWorkerSixb, options: ActionWorkerOptions = {}) {
    super()

    const actions = sixb.getActionDefinitions()
    if (actions.length === 0) {
      console.log("[SixbActionWorker] No action definitions registered; worker will idle.")
    }

    this.context = actions.length > 0 ? buildActionContext(sixb) : null
    this.sixb = sixb
    this.actionIds = new Set(actions.map((action) => action.id))
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY

    if (this.maxConcurrency <= 0) {
      throw new Error("[SixbActionWorker] maxConcurrency must be greater than 0.")
    }
  }

  protected async run(signal: AbortSignal): Promise<void> {
    const inFlight = new Set<Promise<void>>()
    const pending: StoredActionRequestedEvent[] = []
    const dispatch = (event: StoredActionRequestedEvent): void => {
      const task = this.handleActionRequested(event, signal).finally(() => {
        inFlight.delete(task)
        const next = pending.shift()
        if (next && !signal.aborted) dispatch(next)
      })
      inFlight.add(task)
    }

    const unsubscribe = await this.sixb.events.subscribe(
      {
        types: ["action.requested"],
      },
      (events) => {
        for (const event of events) {
          if (event.type !== "action.requested") continue
          if (!this.actionIds.has(event.payload.actionId)) continue
          if (!this.context) continue
          if (signal.aborted) continue

          if (inFlight.size < this.maxConcurrency) {
            dispatch(event)
          } else {
            pending.push(event)
          }
        }
      }
    )

    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    } finally {
      unsubscribe()
      pending.length = 0
      await Promise.allSettled(inFlight)
    }
  }

  private async handleActionRequested(
    event: StoredActionRequestedEvent,
    signal: AbortSignal
  ): Promise<void> {
    const context = this.context
    if (!context) {
      return
    }

    const job: ActionJob = {
      id: event.payload.runId,
      actionId: event.payload.actionId,
      subject: event.payload.subject,
      params: event.payload.params,
    }

    try {
      const result = await runActionJob({
        runtime: context,
        job,
        signal,
      })

      if ("skipped" in result) {
        return
      }

      await emitActionTerminalEvent(this.sixb, result)
    } catch (error) {
      console.error("[SixbActionWorker] Failed to execute action run:", error)
    }
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
