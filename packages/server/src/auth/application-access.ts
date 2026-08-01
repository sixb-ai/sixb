import {
  type AuthSessionAudience,
  canAccessApplication,
  type OntologySource,
  type Sixb,
} from "@sixb/core"
import type { AuthenticatedRequestAuthSession } from "@sixb/core/internal/auth"

export function sessionCanAccessApplication(
  sixb: Sixb<readonly OntologySource[]>,
  session: AuthenticatedRequestAuthSession,
  audience: AuthSessionAudience
): boolean {
  const authorization = sixb.auth.contextFromSession(session)
  return canAccessApplication(authorization, sixb.security.listResolvedRoles(), audience)
}
