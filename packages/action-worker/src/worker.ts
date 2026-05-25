import type {
  ActionDefinition,
  EventsRuntime,
  OntologySource,
  Pario,
  Storage,
  StoredActionRequestedEvent,
} from "@pario/core"
import { Worker } from "@pario/core"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerPario {
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
  private readonly pario: ActionWorkerPario
  private readonly actionIds: ReadonlySet<string>
  private readonly maxConcurrency: number

  constructor(pario: ActionWorkerPario, options: ActionWorkerOptions = {}) {
    super()

    const actions = pario.getActionDefinitions()
    if (actions.length === 0) {
      console.log("[ParioActionWorker] No action definitions registered; worker will idle.")
    }

    this.context = actions.length > 0 ? buildActionContext(pario) : null
    this.pario = pario
    this.actionIds = new Set(actions.map((action) => action.id))
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY

    if (this.maxConcurrency <= 0) {
      throw new Error("[ParioActionWorker] maxConcurrency must be greater than 0.")
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

    const unsubscribe = await this.pario.events.subscribe(
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

      await emitActionTerminalEvent(this.pario, result)
    } catch (error) {
      console.error("[ParioActionWorker] Failed to execute action run:", error)
    }
  }
}

async function emitActionTerminalEvent(
  pario: ActionWorkerPario,
  result: Exclude<ActionRunResult, { skipped: true }>
): Promise<void> {
  try {
    const finishedAt = result.finishedAt.toISOString()

    if (result.status === "succeeded") {
      await pario.events.append({
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

    await pario.events.append({
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
    console.error("[ParioActionWorker] Failed to emit action terminal event:", error)
  }
}

function buildActionContext(pario: ActionWorkerPario): ActionWorkerContext {
  const actionRunsStorage = pario.storage.actionRuns
  if (!actionRunsStorage) {
    throw new Error("[ParioActionWorker] Action workers require storage.actionRuns support.")
  }

  return {
    id: pario.id,
    events: pario.events,
    storage: pario.storage,
    actionRunsStorage,
    pario: pario as unknown as Pario<readonly OntologySource[]>,
    getActionById(actionId) {
      return pario.getActionById(actionId)
    },
  }
}
