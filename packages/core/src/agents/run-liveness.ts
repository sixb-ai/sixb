import { captureSixbFailure, withFailureMessage } from "../errors/internal"
import { AGENT_RUN_FAILURE_CODES, type AgentRunRecord } from "../storage/agents"
import { AgentExecutionLostError, type AgentRunSessionHost, claimAgentRun } from "./run-session"

// A run is held by whoever renews its lease. Once the lease recorded on the run lapses, its run
// token fails closed and nothing may write to it any more, so the run can be ended here: by a
// redelivered queue job, by a worker's repair pass, or by a server that runs no queue at all.

/**
 * The runner running a turn or child stopped, or died, before finishing it. The run is recorded
 * `cancelled` with `finishReason: "interrupted"` rather than replayed: the user already saw it
 * stream and its model calls were billed, so running it again is their call.
 */
export class AgentTurnInterruptedError extends Error {
  readonly name = "AgentTurnInterruptedError"
  constructor(readonly runId: string) {
    super(`[Sixb] Agent run '${runId}' was interrupted when the worker running it stopped.`)
  }
}

/**
 * What a run that stopped with its runner records. A child's tells its parent what to do about it:
 * nothing replays it.
 */
export function interruptedError(run: AgentRunRecord): AgentTurnInterruptedError {
  return run.kind === "subagent"
    ? withFailureMessage(
        new AgentTurnInterruptedError(run.id),
        "The subagent stopped when the worker running it did. Spawn it again with a new key if its answer is still needed: what it already changed stays changed."
      )
    : new AgentTurnInterruptedError(run.id)
}

/** Whether the lease last recorded on a running run has run out. */
export function agentRunLeaseLapsed(run: AgentRunRecord, now = Date.now()): boolean {
  return (
    run.status === "running" &&
    run.execution !== undefined &&
    run.execution.queueLeaseExpiresAt.getTime() <= now
  )
}

/**
 * End a turn or child that nothing runs any more, as interrupted and without calling the model.
 * Reclaiming it first rotates its execution token, so a runner that is only slow, not gone, can
 * no longer write to it. Returns the ended run, or null when it ended or moved meanwhile.
 *
 * `leaseMs` bounds the claim this makes, which lasts only as long as recording the end.
 */
export async function endInterruptedAgentRun(
  host: AgentRunSessionHost,
  run: AgentRunRecord,
  leaseMs: number
): Promise<AgentRunRecord | null> {
  const session = await claimAgentRun(host, {
    run,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
  })
  if (!session) return null
  session.close()

  const completedAt = new Date()
  const error = captureSixbFailure(interruptedError(run), {
    allowedCodes: AGENT_RUN_FAILURE_CODES,
    defaultCode: "runtime.cancelled",
    details:
      run.kind === "conversation"
        ? { runId: run.id, threadId: run.threadId }
        : { parentRunId: run.parentRunId, runId: run.id },
    at: completedAt,
  })
  try {
    const ended = await session.finish({
      status: "cancelled",
      error,
      completedAt,
      finishReason: "interrupted",
    })
    await session.events.publishRunFinished(ended)
    return ended
  } catch (failure) {
    if (failure instanceof AgentExecutionLostError) return null
    throw failure
  }
}

/**
 * End every running turn and child whose lease lapsed. A queue redelivers a dead runner's turn
 * sooner; this is what ends a run no delivery will come back for: one on a computer, a child, or
 * a turn whose end could not be recorded before its job gave up. Returns how many it ended.
 */
export async function endLapsedAgentRuns(
  host: AgentRunSessionHost,
  input: { readonly leaseMs: number }
): Promise<number> {
  let ended = 0
  let offset = 0
  for (;;) {
    const page = await host.storage.agents.runs.list({
      projectId: host.projectId,
      kinds: ["conversation", "subagent"],
      statuses: ["running"],
      order: "asc",
      limit: 100,
      offset,
    })
    const now = Date.now()
    let endedHere = 0
    for (const run of page.runs.filter((candidate) => agentRunLeaseLapsed(candidate, now))) {
      try {
        if (await endInterruptedAgentRun(host, run, input.leaseMs)) endedHere += 1
      } catch (error) {
        console.error(`[Sixb] Could not end lapsed agent run '${run.id}'; retrying later.`, error)
      }
    }
    ended += endedHere
    if (!page.hasMore) return ended
    // Ended runs leave the running set, so the next page starts that much earlier.
    offset += page.runs.length - endedHere
  }
}
