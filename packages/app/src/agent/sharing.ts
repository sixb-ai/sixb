import type { CurrentUser } from "../session"
import type { AgentRun, AgentThread } from "./types"

/** How the signed-in person takes part in a conversation: its owner, or someone it was shared with. */
export type ThreadAccess = "owner" | "participant"

/** Someone in a conversation, with the name their account shows when it has one. */
export interface ThreadPerson {
  readonly principal: { readonly type: string; readonly id: string }
  readonly displayName?: string
}

interface Principal {
  readonly type: string
  readonly id: string
}

export function samePrincipal(a: Principal | null | undefined, b: Principal | null | undefined) {
  return Boolean(a && b && a.type === b.type && a.id === b.id)
}

export function userPrincipal(user: CurrentUser | null): Principal | null {
  return user ? { type: "user", id: user.id } : null
}

/**
 * The reader's part in a thread. Without a signed-in user (auth off) the app acts for the project,
 * which owns every conversation it can read.
 */
export function threadAccess(thread: AgentThread, user: CurrentUser | null): ThreadAccess {
  const me = userPrincipal(user)
  if (!me || samePrincipal(thread.ownerPrincipal, me)) return "owner"

  return "participant"
}

/** The thread's owner, with their name. */
export function threadOwner(thread: AgentThread): ThreadPerson {
  return {
    principal: thread.ownerPrincipal,
    ...nameOf(thread.owner.displayName),
  }
}

/** The people the owner added, with their names. */
export function threadParticipants(thread: AgentThread): readonly ThreadPerson[] {
  return thread.participants.map((participant) => ({
    principal: participant.principal,
    ...nameOf(participant.principal.displayName),
  }))
}

/** A person's name, or their id when their account has none, as #825 names authors. */
export function personName(person: ThreadPerson): string {
  return person.displayName ?? person.principal.id
}

/** Whether a conversation is read by more than its owner. */
export function isShared(thread: AgentThread | null): boolean {
  return Boolean(thread && thread.participants.length > 0)
}

/**
 * Who may retry a run: only whoever asked for it, as it runs again with their rights. Without a
 * signed-in user the project decides; a signed-in reader never retries a run nobody asked for.
 */
export function canRetryRun(run: AgentRun, user: CurrentUser | null): boolean {
  const me = userPrincipal(user)
  if (!me) return true

  return samePrincipal(run.requestedBy, me)
}

/** Whether someone other than the reader asked for a run, as far as the reader can tell. */
export function requestedBySomeoneElse(run: AgentRun | null, user: CurrentUser | null): boolean {
  const me = userPrincipal(user)

  return Boolean(me && run?.requestedBy && !samePrincipal(run.requestedBy, me))
}

/** Who may stop an answer: the thread's owner any answer, a participant only their own. */
export function canStopRun(
  run: AgentRun | null,
  access: ThreadAccess,
  user: CurrentUser | null
): boolean {
  if (access === "owner") return true
  if (!run) return false

  return canRetryRun(run, user)
}

function nameOf(displayName: string | undefined) {
  return displayName ? { displayName } : {}
}
