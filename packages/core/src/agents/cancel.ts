import type { Broker } from "../broker"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type ConversationAgentRunRecord,
} from "../storage/agents"
import { isAwaitingApprovalRun, stopAgentTurn } from "./approvals"
import { AgentRequestError } from "./errors"
import { publishAgentRunCancel, publishAgentRunFinished } from "./streams/protocol"

/**
 * Stop a turn. A queued turn ends here, before any worker starts it. A running turn receives the
 * stop signal its worker obeys, so it is still running when this returns. A turn paused on held
 * calls is returned as it ended, `awaiting_approval`, and never resumes: its waiting calls are
 * cancelled. Who may stop it is the caller's decision.
 */
export async function cancelAgentRun(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<ConversationAgentRunRecord> {
  const storage = runtime.storage.agents
  if (!storage) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }

  let current = run
  if (current.status === "queued") {
    const queued = await cancelQueuedRun(runtime, storage, current)
    if (queued.cancelled) {
      if (queued.run.kind !== "conversation") {
        throw new Error(`[Sixb] Agent run '${queued.run.id}' changed kind.`)
      }
      return queued.run
    }

    if (queued.run?.kind !== "conversation") {
      throw new AgentRequestError("run_not_found", `[Sixb] Agent run '${run.id}' was not found.`)
    }
    current = queued.run
  }

  // A paused turn is stopped from resuming: its waiting calls are cancelled, and the thread's next
  // message reports them and the decided ones. Nothing left to stop means it resumed already.
  if (
    isAwaitingApprovalRun(current) &&
    (await stopAgentTurn(storage, runtime.broker, current)) > 0
  ) {
    return current
  }

  if (current.status !== "running") {
    throw new AgentRequestError(
      "run_not_active",
      `[Sixb] Agent run '${current.id}' is not active: it is ${current.status}.`
    )
  }

  await requestAgentRunCancel({ ...runtime, storage }, current.id)
  return current
}

/**
 * Ask a running turn or child to stop. The cancel is recorded on the run first, so its run token
 * stops working at once, its session over HTTP serves only its end, and a runner that never hears
 * the broker learns of it at its next lease renewal; the broker's cancel then stops a runner that
 * hears it right away.
 */
export async function requestAgentRunCancel(
  host: { readonly projectId: string; readonly broker: Broker; readonly storage: AgentStorage },
  runId: string
): Promise<void> {
  await host.storage.runs.requestCancel({ projectId: host.projectId, id: runId })
  await publishAgentRunCancel(host.broker, { projectId: host.projectId, runId })
}

/**
 * Cancel a queued run before any worker starts it. The worker may have started it after the
 * caller's read but before `finishQueued` locked it: then the run comes back as it is now, for the
 * caller to stop as a running one. A retained control record is safe even if the worker has not
 * attached its cancel subscription yet.
 */
export async function cancelQueuedRun(
  runtime: SixbRuntimeContext,
  storage: AgentStorage,
  run: AgentRunRecord
): Promise<
  | { readonly cancelled: true; readonly run: AgentRunRecord }
  | { readonly cancelled: false; readonly run: AgentRunRecord | null }
> {
  try {
    const cancelled = await storage.runs.finishQueued({
      projectId: runtime.projectId,
      id: run.id,
      status: "cancelled",
    })
    await publishQueuedRunCancellation(runtime, cancelled)
    return { cancelled: true, run: cancelled }
  } catch (error) {
    if (!(error instanceof AgentStorageError) || error.code !== "invalid_state") throw error
  }

  const current = await storage.runs.getById({ projectId: runtime.projectId, id: run.id })
  return { cancelled: false, run: current }
}

/** The run is cancelled once stored; its stream learns it best-effort. */
async function publishQueuedRunCancellation(
  runtime: SixbRuntimeContext,
  run: AgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunFinished(runtime.broker, run)
  } catch (error) {
    console.error(`[Sixb] Agent run '${run.id}' cancellation stream publish failed:`, error)
  }
}
