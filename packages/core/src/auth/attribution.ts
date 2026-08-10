import type { AuthStorage } from "../storage/auth"
import type { Principal } from "./types"

/**
 * Resolve the durable group-membership snapshot used to attribute admitted work.
 *
 * Authorization contexts can carry a token-restricted subset of the principal's groups, so they
 * are deliberately not accepted here. Accounting attribution comes from auth storage whenever it
 * is configured. A system principal, or a runtime with no durable auth storage, has no groups.
 */
export async function snapshotRequesterGroupIds(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly principal: Principal
}): Promise<readonly string[]> {
  if (input.principal.type === "system" || !input.auth) {
    return []
  }

  const memberships =
    input.principal.type === "user"
      ? await input.auth.groupMemberships.listForUser({
          projectId: input.projectId,
          userId: input.principal.id,
        })
      : await input.auth.serviceAccountGroupMemberships.listForServiceAccount({
          projectId: input.projectId,
          serviceAccountId: input.principal.id,
        })

  return [...new Set(memberships.map((membership) => membership.groupId))].sort()
}
