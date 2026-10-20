import { type Principal, SYSTEM_PRINCIPAL } from "@sixb/core"
import { type AgentExecutionAuthorization, agentServiceAccountId } from "@sixb/core/internal/agents"
import type { AuthenticatedRequestAuthSession } from "@sixb/core/internal/auth"
import type { Sixb } from "@sixb/core/internal/request-execution"
import type {
  AgentRunRecord,
  ConversationAgentRunRecord,
  ExecutionRecord,
} from "@sixb/core/storage"
import type { ServerAuthGuardDecision } from "./guard"

/**
 * Per-request authorization state attached by the server's auth derive.
 *
 * Protected domain routes require `sixb`. It is present for authenticated and auth-disabled
 * requests, and absent only for public routes that do not execute protected domain operations.
 */
export interface RequestAuthState {
  readonly sixb: Sixb | null
  /** Present for requests proxied through the run-scoped agent API gateway. */
  readonly agentRun?: ConversationAgentRunRecord
  /** Identifies which kind of active agent execution owns a gateway request. */
  readonly agentExecution?:
    | { readonly kind: "conversation"; readonly runId: string }
    | { readonly kind: "subagent"; readonly runId: string; readonly parentRunId: string }
    | { readonly kind: "workflow"; readonly nodeRunId: string }
}

/** The agent run execution a gateway request runs inside, read from server-side records only. */
export interface AgentGatewayRunExecution {
  readonly execution: ExecutionRecord
  readonly actorId?: string
  readonly runId: string
  readonly attempt: number
  readonly authorization: AgentExecutionAuthorization
}

export interface InternalRequestAuthState {
  /** Absent when auth is disabled: the request then runs as an auth-disabled request. */
  readonly runExecution?: AgentGatewayRunExecution
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
  const { sixb = null, agentRun, agentExecution } = context as Partial<RequestAuthState>
  return {
    sixb,
    ...(agentRun === undefined ? {} : { agentRun }),
    ...(agentExecution === undefined ? {} : { agentExecution }),
  }
}

export function requireRequestSixb(context: unknown): Sixb {
  const sixb = requestAuthState(context).sixb
  if (!sixb) {
    throw new Error("[SixbServer] Execution scope is not available for this route.")
  }
  return sixb
}

/**
 * Who performs the request: a managed Agent run's service account, otherwise the requester.
 * Records of who submitted or cancelled something, and upload-session ownership, name the actor;
 * what the request starts keeps the requester.
 */
export function requestActor(sixb: Pick<Sixb, "execution">): Principal {
  const { executor, requestedBy } = sixb.execution
  if (executor.type === "agent" && executor.actorId !== undefined) {
    return { type: "serviceAccount", id: agentServiceAccountId(executor.actorId) }
  }

  return requestedBy ?? SYSTEM_PRINCIPAL
}

/**
 * The caller the auth guard resolved for this request. Null on public routes, for shared-access and
 * agent-gateway requests, and when auth is disabled.
 */
export function requestCaller(context: unknown): AuthenticatedRequestAuthSession | null {
  const auth = (context as { readonly auth?: ServerAuthGuardDecision }).auth
  return auth?.kind === "allow" ? auth.session : null
}
