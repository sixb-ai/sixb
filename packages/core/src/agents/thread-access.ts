import { type Principal, principalsEqual, SYSTEM_PRINCIPAL, type UserPrincipal } from "../auth"
import { isRuntimeAllowed } from "../authorization"
import type { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { AuthorizablePrincipal } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentRunFailureCode,
  AgentRunFinishReason,
  AgentRunRecord,
  AgentRunStatus,
  AgentStorage,
  AgentThreadRecord,
} from "../storage/agents"
import { AgentRequestError } from "./errors"

/** How the caller takes part in a conversation: its owner, or a user its owner added. */
export type AgentThreadAccess = "owner" | "participant"

/** A user the thread's owner added, who reads the conversation and talks in it. */
export interface AgentThreadParticipant {
  readonly principal: UserPrincipal
  readonly addedAt: Date
  readonly addedBy: Principal
}

/**
 * How far the caller's reading of a thread has reached, and what arrived past it. Reading on one
 * device clears it on every other.
 */
export interface AgentThreadReadView {
  readonly threadId: string
  /** The seq of the last message their reading reached; 0 when it reached none. */
  readonly throughSeq: number
  /** The seq of the thread's newest message, 0 when it has none. */
  readonly headSeq: number
  /**
   * Messages past `throughSeq` that someone else wrote: the Agent's answers and other people's
   * messages. Their own messages are not new to them, nor is a message that only reports how
   * approved calls ended.
   */
  readonly unread: number
  /** When they last marked the thread read, even where their place did not move. */
  readonly readAt?: Date
}

/** The thread's newest run, enough for a client to offer Continue or Retry without reading it. */
export interface AgentThreadLastRunView {
  readonly id: string
  readonly status: AgentRunStatus
  readonly finishReason?: AgentRunFinishReason
  /** Why it failed, when it did. */
  readonly errorCode?: AgentRunFailureCode
  readonly completedAt?: Date
  /**
   * Who asked for it, when it ended short (failed, timed out or interrupted): only they can run it
   * again, as it runs with their rights.
   */
  readonly requestedBy?: AuthorizablePrincipal
}

/** A run that stopped before its answer: it failed, timed out, or its worker went away. */
export function agentRunEndedShort(run: Pick<AgentRunRecord, "status" | "finishReason">): boolean {
  if (run.status === "failed") return true
  return run.finishReason === "timeout" || run.finishReason === "interrupted"
}

/**
 * A thread as the runtime returns it: the stored record with the users taking part in it, the
 * caller's place in it, and its newest run. `read` is absent for an observer, and for system code,
 * which is nobody's reading.
 */
export interface AgentThreadView extends AgentThreadRecord {
  readonly participants: readonly AgentThreadParticipant[]
  readonly read?: AgentThreadReadView
  readonly lastRun?: AgentThreadLastRunView
}

/** A thread the caller can read, and how it takes part in it. */
export interface ReadableAgentThread {
  readonly thread: AgentThreadView
  readonly access: AgentThreadAccess
}

type RuntimeAuthority = ReturnType<typeof resolveRuntimeAuthorizationForProject>

/**
 * The one rule for who reads a conversation through `sixb.agent`.
 *
 * The caller needs `can.run(agent)`, then must own the thread or take part in it. Code without a
 * caller (authorization disabled, or system code) reads every thread as its owner. A shared link,
 * a delegated execution or a denied caller reads none. An observer reads every thread through
 * `sixb.agent.observed` instead, without ever being its owner or a participant.
 *
 * A sub-agent's thread is read exactly when its conversation is, with the caller's access there:
 * whoever stops reading the conversation stops reading its children with it.
 */
export interface AgentThreadAccessRule {
  /** Who acts: the signed-in principal, or the system principal for code without a caller. */
  readonly caller: Principal
  /** The thread and how the caller takes part in it; `null` when it cannot read it. */
  read(threadId: string): Promise<ReadableAgentThread | null>
  /**
   * The conversations among these threads the caller reads, each once, as `read` answers each but
   * read together, in a few queries however many there are. A sub-agent's thread is left out.
   */
  readConversations(threadIds: readonly string[]): Promise<readonly ReadableAgentThread[]>
  /**
   * Whose conversations the caller reads, for a list to ask its storage for those alone: a
   * principal's, as owner or participant; `"every"` for code without a caller; `"none"` when it
   * reads none.
   */
  scope(): { readonly reader: Principal } | "every" | "none"
}

export function createAgentThreadAccessRule(
  runtime: SixbRuntimeContext,
  authority: RuntimeAuthority,
  /** Where threads are read, the project's storage when omitted: a transaction's decides in it. */
  agents?: AgentStorage
): AgentThreadAccessRule {
  const caller = authority.type === "principal" ? authority.context.principal : SYSTEM_PRINCIPAL
  const blocked = authority.type === "denied" || authority.type === "delegated"

  const accessIn = (thread: AgentThreadView): AgentThreadAccess | null => {
    if (blocked || !isRuntimeAllowed(runtime, { kind: "agent.run" })) return null
    if (authority.type !== "principal") return "owner"
    if (principalsEqual(caller, thread.ownerPrincipal)) return "owner"

    return thread.participants.some((participant) => principalsEqual(participant.principal, caller))
      ? "participant"
      : null
  }

  const read = async (threadId: string): Promise<ReadableAgentThread | null> => {
    if (blocked) return null

    const storage = agents ?? runtime.storage.agents
    const getById = (id: string) => storage?.threads.getById({ projectId: runtime.projectId, id })
    const stored = await getById(threadId)
    if (!stored) return null

    // One level only: a child's parent is always a conversation, as storage admits no other.
    const conversation = stored.parent ? await getById(stored.parent.threadId) : stored
    if (conversation?.kind !== "conversation") return null

    const [thread, readThrough = thread] = await agentThreadViews(
      runtime,
      conversation === stored ? [stored] : [stored, conversation],
      storage
    )
    const access = readThrough ? accessIn(readThrough) : null
    return thread && access ? { thread, access } : null
  }

  const readConversations = async (
    threadIds: readonly string[]
  ): Promise<readonly ReadableAgentThread[]> => {
    if (blocked || threadIds.length === 0) return []

    const storage = agents ?? runtime.storage.agents
    const stored =
      (await storage?.threads.getByIds({ projectId: runtime.projectId, ids: threadIds })) ?? []
    const conversations = stored.filter((thread) => thread.kind === "conversation")

    const views = await agentThreadViews(runtime, conversations, storage)
    return views.flatMap((thread) => {
      const access = accessIn(thread)
      return access ? [{ thread, access }] : []
    })
  }

  const scope = (): ReturnType<AgentThreadAccessRule["scope"]> => {
    if (blocked || !isRuntimeAllowed(runtime, { kind: "agent.run" })) return "none"
    return authority.type === "principal" ? { reader: caller } : "every"
  }

  return { caller, read, readConversations, scope }
}

/** Refuse what only a conversation takes: a message, a fork, a participant, a mode, a sandbox. */
export function assertConversationThread(thread: Pick<AgentThreadRecord, "id" | "kind">): void {
  if (thread.kind === "conversation") return
  throw new AgentRequestError(
    "thread_not_conversation",
    `[Sixb] Agent thread '${thread.id}' is a sub-agent's: it is read through its conversation and takes no change of its own.`
  )
}

/**
 * The conversation a thread belongs to: the thread itself, or a sub-agent's parent. What a child
 * publishes, and the thread its sandbox names, are its conversation's.
 */
export function conversationThreadId(thread: Pick<AgentThreadRecord, "id" | "parent">): string {
  return thread.parent?.threadId ?? thread.id
}

/** Stored threads as the runtime returns them, with their participants and no execution tokens. */
export async function agentThreadViews(
  runtime: SixbRuntimeContext,
  threads: readonly AgentThreadRecord[],
  agents: AgentStorage | undefined = runtime.storage.agents
): Promise<readonly AgentThreadView[]> {
  const participants =
    threads.length === 0
      ? []
      : ((await agents?.threads.listParticipants({
          projectId: runtime.projectId,
          threadIds: threads.map((thread) => thread.id),
        })) ?? [])

  return threads.map((thread) => ({
    ...publicThread(thread),
    participants: participants
      .filter((participant) => participant.threadId === thread.id)
      .map(({ principal, addedAt, addedBy }) => ({ principal, addedAt, addedBy })),
  }))
}

/** Execution ownership tokens never leave the storage/worker boundary. */
function publicThread(thread: AgentThreadRecord): AgentThreadRecord {
  if (!thread.sandboxState) return thread

  const { name, status, initialized } = thread.sandboxState
  return { ...thread, sandboxState: { name, status, initialized } }
}
