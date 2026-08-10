import type {
  ActionsRuntime,
  BlobsRuntime,
  ConnectorRuntime,
  RulesRuntime,
  SixbRuntimeContext,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import { createDynamicObjectsRuntime } from "@sixb/core/internal/objects"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ActionRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import { ActionWorkerError } from "./errors"
import { runActionJob } from "./run-action-job"
import type { ActionJob, ActionRunResult, ActionWorkerContext } from "./types"

export interface ActionWorkerSixb extends Omit<SixbRuntimeContext, "blobStorage" | "rules"> {
  readonly id: string
  readonly logs?: LogsRuntime
  readonly actions: Pick<ActionsRuntime, "list" | "getById" | "listForType">
  readonly blobs: Pick<BlobsRuntime, "put" | "open" | "stat">
  readonly connector: ConnectorRuntime
  readonly rules: Pick<RulesRuntime, "list">
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

    const actions = sixb.actions.list()
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
      attempt: job.attempt,
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
  const finishedAt = result.finishedAt.toISOString()

  await sixb.events.emit(
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

function buildActionContext(sixb: ActionWorkerSixb): ActionWorkerContext {
  const actionRunsStorage = sixb.storage.actionRuns
  if (!actionRunsStorage) {
    throw new ActionWorkerError("Action workers require storage.actionRuns support.")
  }
  const runtime = {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobs,
    queues: sixb.queues,
    sandboxes: sixb.sandboxes,
    rules: sixb.rules.list(),
  }

  return {
    id: sixb.id,
    errorReporterHost: sixb,
    events: sixb.events,
    logs: sixb.logs,
    storage: sixb.storage,
    actionRunsStorage,
    ontologyMutations: getOntologyMutationRuntime(sixb),
    sixb: {
      objects: createDynamicObjectsRuntime(runtime),
      actions: sixb.actions,
      connector: sixb.connector,
      blobs: sixb.blobs,
    },
    actions: sixb.actions,
  }
}
