import type { AuthorizablePrincipal } from "@sixb/core"
import type { AuthStorage } from "@sixb/core/storage"

/** Who an Agent run works for, as its prompt names them. */
export type AgentRequester =
  | { readonly type: "user"; readonly id: string; readonly displayName?: string }
  | { readonly type: "serviceAccount" }

/**
 * Resolve the requester of an Agent execution: the user, with their current display name, or a
 * service account. Read when the run starts, so a renamed user is named correctly from the next run.
 */
export async function resolveAgentRequester(input: {
  readonly auth: AuthStorage
  readonly projectId: string
  readonly requestedBy: AuthorizablePrincipal | undefined
}): Promise<AgentRequester | undefined> {
  const { requestedBy } = input
  if (requestedBy === undefined) return undefined
  if (requestedBy.type === "serviceAccount") return { type: "serviceAccount" }

  const user = await input.auth.users.getById({ projectId: input.projectId, id: requestedBy.id })
  const displayName = user?.displayName?.trim()

  return { type: "user", id: requestedBy.id, ...(displayName ? { displayName } : {}) }
}
