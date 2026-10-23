import { type Principal, principalsEqual, SYSTEM_PRINCIPAL, type UserPrincipal } from "../auth"
import { isRuntimeAllowed } from "../authorization"
import type { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { AgentStorage, AgentThreadRecord } from "../storage/agents"

/** How the caller takes part in a conversation: its owner, or a user its owner added. */
export type AgentThreadAccess = "owner" | "participant"

/** A user the thread's owner added, who reads the conversation and talks in it. */
export interface AgentThreadParticipant {
  readonly principal: UserPrincipal
  readonly addedAt: Date
  readonly addedBy: Principal
}

/** A thread as the runtime returns it: the stored record with the users taking part in it. */
export interface AgentThreadView extends AgentThreadRecord {
  readonly participants: readonly AgentThreadParticipant[]
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
 */
export interface AgentThreadAccessRule {
  /** Who acts: the signed-in principal, or the system principal for code without a caller. */
  readonly caller: Principal
  /** The thread and how the caller takes part in it; `null` when it cannot read it. */
  read(threadId: string): Promise<ReadableAgentThread | null>
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
    const stored = await storage?.threads.getById({ projectId: runtime.projectId, id: threadId })
    if (!stored) return null

    const [thread] = await agentThreadViews(runtime, [stored], storage)
    const access = thread ? accessIn(thread) : null
    return thread && access ? { thread, access } : null
  }

  return { caller, read }
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
