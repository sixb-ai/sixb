import type { AuthorizationContext, OntologySource, ScopedSixb } from "@sixb/core"

/**
 * Per-request authorization state attached by the server's auth derive.
 *
 * Both fields are null when auth is disabled or the route is public — those
 * requests run against the privileged runtime, preserving authenticated-only
 * behavior for surfaces that are not grant-enforced yet.
 */
export interface RequestAuthState {
  readonly authz: AuthorizationContext | null
  readonly scoped: ScopedSixb<readonly OntologySource[]> | null
}

/**
 * Read the derived auth state from a route handler's context.
 *
 * Route registrars type `app` as plain `Elysia`, so the derived properties are
 * not visible to handler signatures; this helper is the single typed access
 * point until route registration carries the derived context type.
 */
export function requestAuthState(context: unknown): RequestAuthState {
  const { authz = null, scoped = null } = context as Partial<RequestAuthState>
  return { authz, scoped }
}
