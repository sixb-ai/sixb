import { principalsEqual, type UserPrincipal } from "../auth"
import { userReferenceProblem } from "../ontology/user-ref"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SecurityDefinitionCatalog } from "../security"
import {
  type AgentStorage,
  AgentStorageError,
  type AgentThreadParticipantRecord,
} from "../storage/agents"
import { announceAgentApprovals } from "./approvals"
import { userCanRunAgent } from "./authority"
import { AgentRequestError } from "./errors"
import type { AgentThreadAccessRule, AgentThreadView } from "./thread-access"

/** At most this many users take part in one conversation, besides its owner. */
export const MAX_AGENT_THREAD_PARTICIPANTS = 50

/** A user to add: by id, or by the email of their account. */
export type AgentThreadParticipantInput = UserPrincipal | { readonly email: string }

/** Add users to a conversation. Only its owner may, and only active users of the project. */
export async function addAgentThreadParticipants(
  runtime: SixbRuntimeContext,
  rule: AgentThreadAccessRule,
  security: SecurityDefinitionCatalog,
  threadId: string,
  users: readonly AgentThreadParticipantInput[]
): Promise<AgentThreadView> {
  const storage = requireStorage(runtime)
  const readable = await rule.read(threadId)
  if (!readable) throw threadNotFound(threadId)

  if (readable.access !== "owner") {
    throw new AgentRequestError(
      "not_thread_owner",
      `[Sixb] Only the owner of Agent thread '${threadId}' can add participants to it.`
    )
  }

  const principals = await activeUsers(runtime, security, users)
  if (principals.some((user) => principalsEqual(user, readable.thread.ownerPrincipal))) {
    throw invalidParticipant("The thread's owner already takes part in it; add other users.")
  }

  let participants: readonly AgentThreadParticipantRecord[]
  try {
    participants = await storage.threads.addParticipants({
      projectId: runtime.projectId,
      threadId,
      principals,
      addedBy: rule.caller,
      maxParticipants: MAX_AGENT_THREAD_PARTICIPANTS,
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "participant_limit") {
      throw invalidParticipant(
        `An Agent thread can have at most ${MAX_AGENT_THREAD_PARTICIPANTS} participants.`
      )
    }
    throw error
  }

  return {
    ...readable.thread,
    participants: participants.map(({ principal, addedAt, addedBy }) => ({
      principal,
      addedAt,
      addedBy,
    })),
  }
}

/**
 * Remove a user from a conversation. Its owner removes anyone; a participant removes only
 * themself, which is how they leave. Removing someone who does not take part changes nothing.
 */
export async function removeAgentThreadParticipant(
  runtime: SixbRuntimeContext,
  rule: AgentThreadAccessRule,
  threadId: string,
  user: UserPrincipal
): Promise<void> {
  requireStorage(runtime)
  const readable = await rule.read(threadId)
  if (!readable) throw threadNotFound(threadId)

  const principal = userOf(user)

  if (principalsEqual(principal, readable.thread.ownerPrincipal)) {
    throw invalidParticipant("The thread's owner cannot be removed from it.")
  }
  if (readable.access !== "owner" && !principalsEqual(principal, rule.caller)) {
    throw new AgentRequestError(
      "not_thread_owner",
      `[Sixb] Only the owner of Agent thread '${threadId}' can remove other participants.`
    )
  }

  // Their turns never resume: the calls still waiting are cancelled, and the thread's next message
  // reports what they decided.
  const { cancelled } = await runtime.storage.transaction(async (tx) => {
    const agents = tx.agents
    if (!agents) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    await agents.threads.removeParticipant({ projectId: runtime.projectId, threadId, principal })
    return agents.approvals.stop({ projectId: runtime.projectId, threadId, requestedBy: principal })
  })
  await announceAgentApprovals(runtime.broker, cancelled)
}

/**
 * Each user once, by their account: an email resolves to its user. The only place that checks who
 * may take part: storage receives distinct users and enforces only the limit. An unknown or
 * suspended email is refused in the words an unknown or suspended id is, so it tells no more.
 */
async function activeUsers(
  runtime: SixbRuntimeContext,
  security: SecurityDefinitionCatalog,
  users: readonly AgentThreadParticipantInput[]
): Promise<UserPrincipal[]> {
  if (!Array.isArray(users) || users.length === 0) {
    throw invalidParticipant("Name at least one user.")
  }
  if (users.length > MAX_AGENT_THREAD_PARTICIPANTS) {
    throw invalidParticipant(
      `Add at most ${MAX_AGENT_THREAD_PARTICIPANTS} users to an Agent thread at once.`
    )
  }

  const auth = runtime.storage.auth
  const unique = new Map<string, UserPrincipal>()
  for (const user of users) {
    const email = emailOf(user)
    const account =
      auth &&
      (email === undefined
        ? await auth.users.getById({ projectId: runtime.projectId, id: userOf(user).id })
        : await auth.users.getByEmail({ projectId: runtime.projectId, email }))

    const named = email ?? userOf(user).id
    const status = auth ? (account?.status ?? null) : "unverifiable"
    const problem = userReferenceProblem("Agent thread participant", named, status)
    if (problem || !account || !auth) {
      throw new AgentRequestError(
        "invalid_participant",
        problem ?? `[Sixb] Unknown user '${named}'.`
      )
    }

    // Someone who cannot use the Agent could never read the conversation they were added to.
    const allowed = await userCanRunAgent({
      auth,
      projectId: runtime.projectId,
      userId: account.id,
      security,
    })
    if (!allowed) {
      throw invalidParticipant(
        `User '${named}' cannot use the Agent: a role granting can.run(agent) must reach them first.`
      )
    }

    unique.set(account.id, { type: "user", id: account.id })
  }
  return [...unique.values()]
}

/** The trimmed email of an input naming a user by email; `undefined` for one naming an id. */
function emailOf(user: AgentThreadParticipantInput): string | undefined {
  if (!user || typeof user !== "object" || !("email" in user)) return undefined

  const email = typeof user.email === "string" ? user.email.trim() : ""
  if (!email) throw invalidParticipant("A user's email must not be empty.")
  return email
}

/** A user named by id, with the id trimmed. */
function userOf(user: AgentThreadParticipantInput): UserPrincipal {
  const id =
    user && "type" in user && user.type === "user" && typeof user.id === "string"
      ? user.id.trim()
      : ""
  if (!id) {
    throw invalidParticipant(
      `Only users take part in an Agent thread: pass { type: "user", id } or { email }, not ${JSON.stringify(user)}.`
    )
  }
  return { type: "user", id }
}

function requireStorage(runtime: SixbRuntimeContext): AgentStorage {
  const storage = runtime.storage.agents
  if (!storage) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return storage
}

function threadNotFound(threadId: string): AgentRequestError {
  return new AgentRequestError("thread_not_found", `[Sixb] Agent thread '${threadId}' not found.`)
}

function invalidParticipant(message: string): AgentRequestError {
  return new AgentRequestError("invalid_participant", `[Sixb] ${message}`)
}
