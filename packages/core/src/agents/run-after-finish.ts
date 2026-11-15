import { principalsEqual } from "../auth"
import { captureSixbFailure, createSixbError } from "../errors/internal"
import { bindDurableAgentExecution } from "../execution/agent"
import { isJsonObject } from "../json"
import {
  AGENT_RUN_FAILURE_CODES,
  type AgentInboxItemRecord,
  type AgentRunRecord,
  AgentStorageError,
  type SubagentRunRecord,
} from "../storage/agents"
import { resumeDecidedAgentTurn } from "./approval-continuation"
import { isAwaitingApprovalRun } from "./approvals"
import { requestAgentRunCancel } from "./cancel"
import { startQueuedAgentTurn } from "./queued-turn"
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

  // One read for both: a steer the turn never wrote waits again, whatever ended it, and what it
  // leaves behind is what a turn that answered may start. Most turns end with an empty inbox, and
  // then read nothing else and write nothing.
  const inbox = await readInbox(host, run)
  if (inbox?.claimed) await releaseInboxClaims(host, run.id)
  if (isAwaitingApprovalRun(run)) {
    await resumeDecidedTurn(host, run)
    return
  }
  if (!inbox || inbox.waiting.length === 0) return
  await startNextQueuedMessage(host, run, inbox.waiting)
}

const INBOX_REPAIR_PAGE_SIZE = 100
/** How long a turn's own end has to start what waits, before the repair pass looks at it. */
const INBOX_REPAIR_GRACE_MS = 30_000

/**
 * The repair pass for thread inboxes: what a turn's end did not start, because its process stopped
 * first, a read failed, or an AI limit refused it, starts by the same rules the end applies, as
 * that turn's requester. Claims a finished turn left behind go back first. A message those rules
 * keep waiting (another participant's, or one queued behind a turn that stopped) is left alone.
 */
export async function repairAgentInboxes(
  host: AgentRunSessionHost,
  input: { readonly now?: Date } = {}
): Promise<void> {
  const createdBefore = new Date((input.now ?? new Date()).getTime() - INBOX_REPAIR_GRACE_MS)
  let afterThreadId: string | undefined
  for (;;) {
    const threadIds = await host.storage.agents.inbox.listWaitingThreads({
      projectId: host.projectId,
      createdBefore,
      limit: INBOX_REPAIR_PAGE_SIZE,
      ...(afterThreadId === undefined ? {} : { afterThreadId }),
    })
    for (const threadId of threadIds) {
      try {
        await repairThreadInbox(host, threadId)
      } catch (error) {
        console.error(
          `[Sixb] Could not repair the inbox of Agent thread '${threadId}'; retrying.`,
          error
        )
      }
    }
    afterThreadId = threadIds.at(-1)
    if (afterThreadId === undefined || threadIds.length < INBOX_REPAIR_PAGE_SIZE) return
  }
}

async function repairThreadInbox(host: AgentRunSessionHost, threadId: string): Promise<void> {
  const { runs } = await host.storage.agents.runs.list({
    projectId: host.projectId,
    threadId,
    kinds: ["conversation"],
    order: "desc",
    limit: 1,
  })
  const last = runs[0]
  // A turn holds the thread again, or never ran in it: its end, or its first turn, starts these.
  if (!last || last.status === "queued" || last.status === "running") return

  const items = await host.storage.agents.inbox.list({ projectId: host.projectId, threadId })
  const holders = new Set(items.flatMap((item) => (item.claimedBy ? [item.claimedBy.runId] : [])))
  for (const runId of holders) await releaseInboxClaims(host, runId)
  // The approval repair resumes a paused turn, and that turn's end starts what waits.
  if (isAwaitingApprovalRun(last)) return
  await startNextQueuedMessage(host, last, items)
}

/**
 * The thread's inbox as a finished turn leaves it: what it still holds claimed, and what a turn may
 * start once those are released. Null when it cannot be read, which the repair pass catches up on.
 */
async function readInbox(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<{
  readonly claimed: boolean
  readonly waiting: readonly AgentInboxItemRecord[]
} | null> {
  // A storage without an inbox holds nothing to read, release or start.
  const inbox = host.storage.agents.inbox
  if (typeof inbox?.list !== "function") return null
  try {
    const items = await inbox.list({
      projectId: host.projectId,
      threadId: run.threadId,
      includeClaimed: true,
    })
    const claimed = items.some((item) => item.claimedBy?.runId === run.id)
    return {
      claimed,
      waiting: items.filter(
        (item) => item.claimedBy === undefined || item.claimedBy.runId === run.id
      ),
    }
  } catch (error) {
    console.error(
      `[Sixb] Could not read the inbox of Agent run '${run.id}'; repair retries it.`,
      error
    )
    return null
  }
}

/**
 * Start the next message its requester queued for the thread: always one they sent now, and a
 * message queued for later only once the turn answered, so nothing runs after a turn that stopped
 * or failed, or one that asked the requester a question.
 */
async function startNextQueuedMessage(
  host: AgentRunSessionHost,
  run: AgentRunRecord,
  waiting: readonly AgentInboxItemRecord[]
): Promise<void> {
  try {
    const execution = await host.storage.executions.getById({
      projectId: host.projectId,
      id: run.executionId,
    })
    const requester = execution?.requestedBy
    if (!requester) return

    // Only the turn's requester starts their own messages: a turn runs as its requester.
    const onlyImmediate = !(await turnAnsweredEveryMessage(host, run))
    const next = waiting.some(
      (item) =>
        (!onlyImmediate || item.immediate) && principalsEqual(item.authorPrincipal, requester)
    )
    if (!next) return

    const scope = await resolveAgentRunExecutionScope(
      { id: host.projectId, storage: host.storage, definitions: { security: host.security } },
      { runId: run.id, executionId: run.executionId, authority: { type: "inherited" } }
    )
    await startQueuedAgentTurn(bindDurableAgentExecution(host.sdk, scope), run.id, {
      onlyImmediate,
    })
  } catch (error) {
    // Its turn is recorded: the message waits in the thread, and the repair pass catches up.
    console.error(
      `[Sixb] Could not start what was queued after Agent run '${run.id}'; it waits in the thread.`,
      error
    )
  }
}

/** Whether the turn answered: it succeeded without asking a question the requester answers next. */
async function turnAnsweredEveryMessage(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<boolean> {
  if (run.status !== "succeeded") return false
  const { messages } = await host.storage.agents.messages.list({
    projectId: host.projectId,
    threadId: run.threadId,
    roles: ["assistant"],
    order: "desc",
    limit: 1,
  })
  const answer = messages[0]
  if (!answer || answer.runId !== run.id) return true
  // `ask` answers `{ status: "asked" }`: the requester's next message is their answer, so a message
  // they queued instead is not one.
  return !answer.parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.state === "output-available" &&
      isJsonObject(part.output) &&
      part.output.status === "asked"
  )
}

/** Whatever a run stopped writing goes back to the thread's inbox, to be read again. */
async function releaseInboxClaims(host: AgentRunSessionHost, runId: string): Promise<void> {
  try {
    await host.storage.agents.inbox.releaseClaimed({ projectId: host.projectId, runId })
  } catch (error) {
    console.error(
      `[Sixb] Could not release the inbox claims of Agent run '${runId}'; repair retries.`,
      error
    )
  }
}

/** Resume a turn paused on calls already decided, as its requester. */
async function resumeDecidedTurn(host: AgentRunSessionHost, run: AgentRunRecord): Promise<void> {
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
