import type { AuthorizationContext, OntologySource, ScopedSixb } from "@sixb/core"
import type { AgentRunRecord } from "@sixb/core/storage"

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
 *   - A grant-enforced handler MUST use `scoped` (falling back to the raw
 *     `sixb` only when `scoped` is null). That now covers writes as well as
 *     reads: object, link, and telemetry writes enforce `edit:object` and
 *     `append:telemetry`. Using the raw `sixb` on a path an authenticated
 *     principal can reach is a silent god-mode bypass — it will not fail to
 *     compile or to run.
 *   - Surfaces with no grant family yet (auth admin, raw storage) stay
 *     authenticated-only by design and use the raw `sixb` deliberately, not by
 *     omission. Add such a route consciously, and lock it down when its grant
 *     family lands.
 *
 * This implicit default is a known V1 trade-off (kept for runtime ergonomics);
 * if it proves error-prone, make privileged access explicit at this boundary.
 */
export interface RequestAuthState {
  readonly authz: AuthorizationContext | null
  readonly scoped: ScopedSixb<readonly OntologySource[]> | null
  /** Present for requests proxied through the run-scoped agent API gateway. */
  readonly agentRun?: AgentRunRecord
  /** Identifies which kind of active agent execution owns a gateway request. */
  readonly agentExecution?:
    | { readonly kind: "conversation"; readonly runId: string }
    | { readonly kind: "workflow"; readonly nodeRunId: string }
}

const internalRequestAuthState = new WeakMap<Request, RequestAuthState>()

export function registerInternalRequestAuthState(
  request: Request,
  authState: RequestAuthState
): void {
  internalRequestAuthState.set(request, authState)
}

export function consumeInternalRequestAuthState(request: Request): RequestAuthState | undefined {
  const authState = internalRequestAuthState.get(request)
  if (authState) {
    internalRequestAuthState.delete(request)
  }
  return authState
}

/**
 * Read the derived auth state from a route handler's context.
 *
 * Route registrars type `app` as plain `Elysia`, so the derived properties are
 * not visible to handler signatures; this helper is the single typed access
 * point until route registration carries the derived context type.
 */
export function requestAuthState(context: unknown): RequestAuthState {
  const {
    authz = null,
    scoped = null,
    agentRun,
    agentExecution,
  } = context as Partial<RequestAuthState>
  return {
    authz,
    scoped,
    ...(agentRun === undefined ? {} : { agentRun }),
    ...(agentExecution === undefined ? {} : { agentExecution }),
  }
}
