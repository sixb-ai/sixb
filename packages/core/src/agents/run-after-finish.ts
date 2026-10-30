import { captureSixbFailure, createSixbError } from "../errors/internal"
import { bindDurableAgentExecution } from "../execution/agent"
import {
  AGENT_RUN_FAILURE_CODES,
  type AgentRunRecord,
  AgentStorageError,
  type SubagentRunRecord,
} from "../storage/agents"
import { resumeDecidedAgentTurn } from "./approval-continuation"
import { isAwaitingApprovalRun } from "./approvals"
import { requestAgentRunCancel } from "./cancel"
import { resolveAgentRunExecutionScope } from "./run-scope"
import type { AgentRunSessionHost } from "./run-session"

// What follows a turn's end, wherever its runner was: the worker's session does it, and so does
// the API's for a runner that reaches it over HTTP. Best effort: a failure is logged, and a repair
// pass catches up.

/** A turn ended: its children still at work stop, and one paused on decided calls goes on. */
export async function afterAgentRunFinished(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<void> {
  if (run.kind !== "conversation") return
  const ended =
    run.finishReason === "interrupted"
      ? "was interrupted"
      : run.status === "succeeded"
        ? "has finished"
        : `was ${run.status}`
  await stopActiveChildren(host, run.id, `The parent Agent run ${ended}.`)
  if (!isAwaitingApprovalRun(run)) return
  try {
    // As its requester, with the grants they have now: what a decision would have done.
    const scope = await resolveAgentRunExecutionScope(
      { id: host.projectId, storage: host.storage, definitions: { security: host.security } },
      { runId: run.id, executionId: run.executionId, authority: { type: "inherited" } }
    )
    await resumeDecidedAgentTurn(bindDurableAgentExecution(host.sdk, scope), run.id)
  } catch (error) {
    console.error(`[Sixb] Could not resume Agent run '${run.id}'; retrying later.`, error)
  }
}

async function stopActiveChildren(
  host: AgentRunSessionHost,
  parentRunId: string,
  message: string
): Promise<void> {
  let children: readonly AgentRunRecord[]
  try {
    children = (
      await host.storage.agents.runs.list({
        projectId: host.projectId,
        kinds: ["subagent"],
        parentRunId,
        statuses: ["queued", "running"],
        order: "asc",
        limit: 100,
      })
    ).runs
  } catch (error) {
    console.error(
      `[Sixb] Could not list the active children of Agent run '${parentRunId}'; the repair pass retries.`,
      error
    )
    return
  }
  await Promise.all(
    children.map(async (child) => {
      if (child.kind !== "subagent") return
      try {
        await stopAgentRunChild(host, child, message)
      } catch (error) {
        console.error(
          `[Sixb] Could not stop subagent run '${child.id}'; the repair pass retries.`,
          error
        )
      }
    })
  )
}

/**
 * Stop a child whose parent ended: a queued one ends cancelled here, with why; a running one is
 * told to stop, which its runner obeys. One whose lease lapsed has no runner left to obey: the
 * repair pass ends it (see endLapsedAgentRuns).
 */
export async function stopAgentRunChild(
  host: AgentRunSessionHost,
  run: SubagentRunRecord,
  message: string
): Promise<void> {
  const cancelHost = {
    projectId: host.projectId,
    broker: host.broker,
    storage: host.storage.agents,
  }
  if (run.status === "running") {
    await requestAgentRunCancel(cancelHost, run.id)
    return
  }
  if (run.status !== "queued") return

  const completedAt = new Date()
  const details = { parentRunId: run.parentRunId, runId: run.id }
  const error = captureSixbFailure(createSixbError("runtime.cancelled", message, { details }), {
    allowedCodes: AGENT_RUN_FAILURE_CODES,
    defaultCode: "runtime.cancelled",
    details,
    at: completedAt,
  })
  try {
    const cancelled = await host.storage.agents.runs.finishQueued({
      projectId: host.projectId,
      id: run.id,
      status: "cancelled",
      error,
      completedAt,
    })
    await host.events.publishRunFinished(cancelled)
  } catch (failure) {
    if (!(failure instanceof AgentStorageError) || failure.code !== "invalid_state") throw failure
    // It started meanwhile: tell its runner instead.
    const current = await host.storage.agents.runs.getById({
      projectId: host.projectId,
      id: run.id,
    })
    if (current?.kind === "subagent" && current.status === "running") {
      await requestAgentRunCancel(cancelHost, run.id)
    }
  }
}
