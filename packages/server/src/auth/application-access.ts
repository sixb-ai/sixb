import { type AuthSessionAudience, canAccessApplication, type SixbHostRuntime } from "@sixb/core"
import type { AuthenticatedRequestAuthSession } from "@sixb/core/internal/auth"

export function sessionCanAccessApplication(
  host: SixbHostRuntime,
  session: AuthenticatedRequestAuthSession,
  audience: AuthSessionAudience
): boolean {
  const authorization = host.auth.contextFromSession(session)
  return canAccessApplication(authorization, host.security.listResolvedRoles(), audience)
}
