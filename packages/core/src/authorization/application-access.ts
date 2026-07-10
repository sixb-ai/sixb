import type { AuthSessionAudience } from "../auth/audience"
import { isAllowed } from "./decision"
import type { AuthorizationContext, ResolvedRole } from "./types"

/** Whether declaring roles has enabled an allowlist for an application. */
export function isApplicationAccessControlled(
  roles: readonly ResolvedRole[],
  audience: AuthSessionAudience
): boolean {
  return roles.some((role) => role.grants["access:application"].has(audience))
}

/**
 * Application access is opt-in for compatibility. Once any role grants an
 * application, principals without that grant are denied.
 */
export function canAccessApplication(
  authorization: AuthorizationContext,
  roles: readonly ResolvedRole[],
  audience: AuthSessionAudience
): boolean {
  return (
    !isApplicationAccessControlled(roles, audience) ||
    isAllowed(authorization, { kind: "application.access", audience })
  )
}
