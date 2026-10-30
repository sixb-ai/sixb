import type { AuthorizablePrincipal } from "@sixb/core"

/** Who an Agent run works for, as its prompt names them. */
export type AgentRequester =
  | { readonly type: "user"; readonly id: string; readonly displayName?: string }
  | { readonly type: "serviceAccount" }

/**
 * The requester of an Agent execution: the user, with their display name as the run read it when
 * it started, or a service account. A renamed user is named correctly from the next run.
 */
export function agentRequester(
  requestedBy: AuthorizablePrincipal | undefined,
  names: Readonly<Record<string, string>>
): AgentRequester | undefined {
  if (requestedBy === undefined) return undefined
  if (requestedBy.type === "serviceAccount") return { type: "serviceAccount" }

  const displayName = names[`user:${requestedBy.id}`]?.trim()
  return { type: "user", id: requestedBy.id, ...(displayName ? { displayName } : {}) }
}
