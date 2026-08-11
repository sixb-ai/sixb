import type { OntologySource } from "@sixb/core"
import type {
  ExecutionSixb,
  RequestExecutionAuthorization,
} from "@sixb/core/internal/request-execution"
import type { AgentRunRecord } from "@sixb/core/storage"

/**
 * Per-request authorization state attached by the server's auth derive.
 *
 * Protected domain routes require `sdk`. It is present for authenticated and auth-disabled
 * requests, and absent only for public routes that do not execute protected domain operations.
 */
export interface RequestAuthState {
  readonly sdk: ExecutionSixb<readonly OntologySource[]> | null
  /** Present for requests proxied through the run-scoped agent API gateway. */
  readonly agentRun?: AgentRunRecord
  /** Identifies which kind of active agent execution owns a gateway request. */
  readonly agentExecution?:
    | { readonly kind: "conversation"; readonly runId: string }
    | { readonly kind: "workflow"; readonly nodeRunId: string }
}

export interface InternalRequestAuthState {
  readonly authorization: RequestExecutionAuthorization
  readonly agentRun?: AgentRunRecord
  readonly agentExecution?: RequestAuthState["agentExecution"]
}

const internalRequestAuthState = new WeakMap<Request, InternalRequestAuthState>()

export function registerInternalRequestAuthState(
  request: Request,
  authState: InternalRequestAuthState
): void {
  internalRequestAuthState.set(request, authState)
}

export function consumeInternalRequestAuthState(
  request: Request
): InternalRequestAuthState | undefined {
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
  const { sdk = null, agentRun, agentExecution } = context as Partial<RequestAuthState>
  return {
    sdk,
    ...(agentRun === undefined ? {} : { agentRun }),
    ...(agentExecution === undefined ? {} : { agentExecution }),
  }
}

export function requireRequestSdk(context: unknown): ExecutionSixb<readonly OntologySource[]> {
  const sdk = requestAuthState(context).sdk
  if (!sdk) {
    throw new Error("[SixbServer] Execution scope is not available for this route.")
  }
  return sdk
}
