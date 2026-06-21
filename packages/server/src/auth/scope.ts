import type { AuthorizationContext, OntologySource, ScopedSixb } from "@sixb/core"

/**
 * Per-request authorization state attached by the server's auth derive.
 *
 * Both fields are null when auth is disabled or the route is public — those
 * requests run against the privileged runtime, preserving authenticated-only
 * behavior for surfaces that are not grant-enforced yet.
 *
 * SECURITY — privileged is the silent default. The core runtime treats a
 * missing authorization context as fully privileged (workers, syncs, tests
 * need that). A scoped principal therefore gains no protection unless the route
 * actively routes through `scoped`. Concretely:
 *
 *   - A grant-enforced read/list/query/action/workflow handler MUST use
 *     `scoped` (falling back to the raw `sixb` only when `scoped` is null).
 *     Using the raw `sixb` on a path an authenticated principal can reach is a
 *     silent god-mode bypass — it will not fail to compile or to run.
 *   - Surfaces with no grant family yet (object/link/telemetry writes,
 *     projections, workflow run history, auth admin) stay
 *     authenticated-only by design and use the raw `sixb`
 *     deliberately, not by omission. Add such a route consciously, and lock it
 *     down when its grant family lands.
 *
 * This implicit default is a known V1 trade-off (kept for runtime ergonomics);
 * if it proves error-prone, make privileged access explicit at this boundary.
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
