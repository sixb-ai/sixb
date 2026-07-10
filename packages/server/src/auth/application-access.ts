import {
  type AuthenticatedRequestAuthSession,
  type AuthSessionAudience,
  canAccessApplication,
  type OntologySource,
  type Sixb,
} from "@sixb/core"

export function sessionCanAccessApplication(
  sixb: Sixb<readonly OntologySource[]>,
  session: AuthenticatedRequestAuthSession,
  audience: AuthSessionAudience
): boolean {
  const authorization = sixb.auth.contextFromSession(session)
  return canAccessApplication(authorization, sixb.security.getResolvedRoles(), audience)
}
