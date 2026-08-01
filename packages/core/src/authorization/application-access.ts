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
 * Whether this principal may open this application.
 *
 * KNOWN LIMITATION (0.1.x): application access is the one capability that is **not** deny-by-default.
 * While no role mentions an application, every authenticated principal may open it; the allowlist only
 * switches on once some role grants it. Every other capability — `view`, `apply`, `run`, `observe` —
 * denies unless granted, so this is the single asymmetry in the model.
 *
 * It is deliberate for now: flipping it would lock every project out of Atlas until it declares a role,
 * including projects with no security definitions at all. Closing it means shipping a default grant with
 * the scaffold first, and it is a breaking change for any project relying on the open default.
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
