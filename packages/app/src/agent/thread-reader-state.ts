import type { AgentThread } from "./types"

/**
 * What a session asks of the person reading it. The words are the app's; the facts are the
 * server's: a call waiting on them, a turn in flight, and what they have not read yet.
 */
export type AgentThreadState = "needs-you" | "working" | "finished" | "idle"

/**
 * The state of a session for one reader, in order: something waits on them, a turn runs, something
 * arrived since they last looked, or nothing does.
 *
 * `waiting` is a pending approval of theirs in this thread, from `agent.approvals.list()`. A turn
 * that ended short and can be continued or retried counts too, which is why the thread carries its
 * newest run: a failed turn writes no message, so unread cannot see it.
 */
export function agentThreadState(
  thread: Pick<AgentThread, "activeRunId" | "lastRun" | "read">,
  waiting: boolean
): AgentThreadState {
  if (waiting || offersContinue(thread.lastRun)) return "needs-you"
  if (thread.activeRunId !== null) return "working"
  if ((thread.read?.unread ?? 0) > 0) return "finished"
  return "idle"
}

/** A turn that ended short, with something to continue or retry, as the transcript offers it. */
function offersContinue(lastRun: AgentThread["lastRun"]): boolean {
  if (!lastRun) return false
  if (lastRun.status === "failed") return true
  return lastRun.finishReason === "timeout" || lastRun.finishReason === "interrupted"
}
