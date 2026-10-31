import type { AuthorizablePrincipal } from "@sixb/core"
import type { AgentRunPeople } from "@sixb/core/internal/agents"

/** Who an Agent run works for, as its prompt names them. */
export type AgentRequester =
  | { readonly type: "user"; readonly id: string; readonly displayName?: string }
  | { readonly type: "serviceAccount" }

/**
 * Resolve the requester of an Agent execution: the user, with their current display name, or a
 * service account. Read when the run starts, so a renamed user is named correctly from the next run.
 */
export async function resolveAgentRequester(input: {
  readonly people: Pick<AgentRunPeople, "user">
  readonly requestedBy: AuthorizablePrincipal | undefined
}): Promise<AgentRequester | undefined> {
  const { requestedBy } = input
  if (requestedBy === undefined) return undefined
  if (requestedBy.type === "serviceAccount") return { type: "serviceAccount" }

  const user = await input.people.user(requestedBy.id)
  const displayName = user?.displayName?.trim()

  return { type: "user", id: requestedBy.id, ...(displayName ? { displayName } : {}) }
}
