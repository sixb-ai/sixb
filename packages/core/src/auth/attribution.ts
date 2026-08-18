import { compareStrings } from "../json"
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

  return normalizeRequesterGroupIds(memberships.map((membership) => membership.groupId))
}

/** Validate and canonicalize an immutable requester-group snapshot at a storage boundary. */
export function normalizeRequesterGroupIds(groupIds: readonly string[]): readonly string[] {
  if (!Array.isArray(groupIds)) {
    throw new TypeError("[Sixb] requesterGroupIds must be an array.")
  }
  const unique = new Set<string>()
  for (const groupId of groupIds) {
    if (typeof groupId !== "string" || groupId.trim().length === 0) {
      throw new TypeError("[Sixb] requesterGroupIds entries must be nonblank.")
    }
    unique.add(groupId)
  }
  return [...unique].sort(compareStrings)
}
