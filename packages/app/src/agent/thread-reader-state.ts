import type { CurrentUser } from "../session"
import { CONTEXT_LIMIT_EXCEEDED } from "./run-presentation"
import { samePrincipal, userPrincipal } from "./sharing"
import type { AgentThread } from "./types"

/**
 * What a session asks of the person reading it. The words are the app's; the facts are the
 * server's: a call waiting on them, a turn in flight, and what arrived since they last looked.
 */
export type AgentThreadState = "needs-you" | "working" | "finished" | "idle"

type ThreadStateSources = Pick<AgentThread, "activeRunId" | "lastRun" | "read">

/**
 * The state of a session for one reader, in this order:
 *
 * - `needs-you`: a call waits on their approval, or a turn they asked for ended short since they
 *   last looked, and they can run it again.
 * - `working`: a turn runs.
 * - `finished`: something arrived since they last looked: an answer, someone's message, or
 *   another person's turn that ended short.
 * - `idle`: nothing did.
 *
 * Looking, which marking the thread read records, settles a turn that ended short as it settles
 * the messages before it: Done clears both. Without a place in the thread (an observer, or a
 * project without sign-in) only approvals and running turns show.
 *
 * `waiting` is a pending approval of theirs in this thread, from `agent.approvals.list()`.
 */
export function agentThreadState(
  thread: ThreadStateSources,
  reader: { readonly waiting: boolean; readonly user: CurrentUser | null }
): AgentThreadState {
  const endedShort = unseenShortTurn(thread)

  if (reader.waiting) return "needs-you"
  if (endedShort && canRunAgain(endedShort, reader.user)) return "needs-you"
  if (thread.activeRunId !== null) return "working"
  if (endedShort || (thread.read?.unread ?? 0) > 0) return "finished"
  return "idle"
}

type LastRun = NonNullable<AgentThread["lastRun"]>

/**
 * The newest turn, when it stopped before its answer and the reader has not looked since. The
 * server says the same of a run (`agentRunEndedShort`) when it names who asked for it.
 */
function unseenShortTurn(thread: ThreadStateSources): LastRun | null {
  const { lastRun, read } = thread
  if (!lastRun || !read) return null

  const endedShort =
    lastRun.status === "failed" ||
    lastRun.finishReason === "timeout" ||
    lastRun.finishReason === "interrupted"
  if (!endedShort) return null

  const seen =
    read.readAt !== undefined &&
    (lastRun.completedAt === undefined ||
      Date.parse(read.readAt) >= Date.parse(lastRun.completedAt))

  return seen ? null : lastRun
}

/**
 * Whether the transcript offers this reader Continue or Retry: only whoever asked for the turn
 * runs it again, and never a conversation too long for its model, which would fail the same way.
 */
function canRunAgain(lastRun: LastRun, user: CurrentUser | null): boolean {
  if (lastRun.errorCode === CONTEXT_LIMIT_EXCEEDED) return false

  return samePrincipal(lastRun.requestedBy, userPrincipal(user))
}
