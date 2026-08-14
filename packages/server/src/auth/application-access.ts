import { type AuthSessionAudience, canAccessApplication, type SixbHostView } from "@sixb/core"
import type { AuthenticatedRequestAuthSession } from "@sixb/core/internal/auth"

export function sessionCanAccessApplication(
  host: SixbHostView,
  session: AuthenticatedRequestAuthSession,
  audience: AuthSessionAudience
): boolean {
  const authorization = host.auth.contextFromSession(session)
  return canAccessApplication(
    authorization,
    host.definitions.security.listResolvedRoles(),
    audience
  )
}
