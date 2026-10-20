import type { SixbRuntimeContext } from "../runtime/types"
import { AgentStorageError, type ConversationAgentRunRecord } from "../storage/agents"
import { AgentRequestError } from "./errors"
import { publishAgentRunCancel, publishAgentRunFinished } from "./streams/protocol"

/**
 * Stop a turn. A queued turn ends here, before any worker starts it. A running turn receives the
 * stop signal its worker obeys, so it is still running when this returns. Who may stop it is the
 * caller's decision.
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
    try {
      const cancelled = await storage.runs.finishQueued({
        projectId: runtime.projectId,
        id: current.id,
        status: "cancelled",
      })
      if (cancelled.kind !== "conversation") {
        throw new Error(`[Sixb] Agent run '${cancelled.id}' changed kind.`)
      }

      await publishQueuedRunCancellation(runtime, cancelled)
      return cancelled
    } catch (error) {
      if (!(error instanceof AgentStorageError) || error.code !== "invalid_state") throw error

      // The worker may have started the run after our read but before finishQueued locked it.
      // Re-read so that pickup race becomes a running-run cancellation instead of an invalid-state
      // error. A retained control record is safe even if the worker has not attached its cancel
      // subscription yet.
      const refreshed = await storage.runs.getById({ projectId: runtime.projectId, id: run.id })
      if (refreshed?.kind !== "conversation") {
        throw new AgentRequestError("run_not_found", `[Sixb] Agent run '${run.id}' was not found.`)
      }
      current = refreshed
    }
  }

  if (current.status !== "running") {
    throw new AgentRequestError(
      "run_not_active",
      `[Sixb] Agent run '${current.id}' is not active: it is ${current.status}.`
    )
  }

  await publishAgentRunCancel(runtime.broker, { projectId: runtime.projectId, runId: current.id })
  return current
}

/** The run is cancelled once stored; its stream learns it best-effort. */
async function publishQueuedRunCancellation(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunFinished(runtime.broker, run)
  } catch (error) {
    console.error(`[Sixb] Agent run '${run.id}' cancellation stream publish failed:`, error)
  }
}
