import { assertAgentExecutionRecord } from "../execution/agent"
import type { SecurityDefinitionCatalog } from "../security"
import type { AuthStorage } from "../storage/auth"
import type { ExecutionRecord, ExecutionStorage } from "../storage/executions"
import {
  type AgentExecutionAuthorization,
  resolveAgentExecutionAuthorization,
  resolveInheritedAgentExecutionAuthorization,
} from "./authority"

export interface AgentRunScopeHost {
  readonly id: string
  readonly storage: { readonly executions: ExecutionStorage; readonly auth?: AuthStorage }
  readonly definitions: { readonly security: SecurityDefinitionCatalog }
}

/** A conversation turn or a child inherits its requester's authority; a workflow node is managed. */
export type AgentRunScopeAuthority =
  | { readonly type: "inherited" }
  | { readonly type: "managed"; readonly actorId: string }

/** What an Agent run's work is bound to: its own execution, with its current grants. */
export interface AgentRunExecutionScope {
  readonly execution: ExecutionRecord
  readonly actorId?: string
  readonly runId: string
  readonly authorization: AgentExecutionAuthorization
}

export type AgentRunScopeErrorCode =
  /** The run's execution record is missing. */
  | "execution_unavailable"
  /** The record names a principal, and the runtime has no auth storage to resolve it. */
  | "auth_unavailable"
  /** The record's authority no longer resolves, or does not belong to the run. */
  | "authority_invalid"

export class AgentRunScopeError extends Error {
  readonly name = "AgentRunScopeError"

  constructor(
    readonly code: AgentRunScopeErrorCode,
    message: string
  ) {
    super(message)
  }
}

/**
 * Restore an Agent run's execution from server-side records only: the run's execution record, then
 * the grants its authority has now. The agent API gateway binds every request to it, and a decided
 * approval runs its call under it.
 */
export async function resolveAgentRunExecutionScope(
  host: AgentRunScopeHost,
  run: {
    readonly runId: string
    readonly executionId: string
    readonly authority: AgentRunScopeAuthority
  }
): Promise<AgentRunExecutionScope> {
  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!execution) {
    throw new AgentRunScopeError(
      "execution_unavailable",
      `[Sixb] Agent run '${run.runId}' execution is not available.`
    )
  }

  // Authority comes from the record whether auth is enabled or not: an auth-disabled record is
  // unrestricted, and a workflow AI task has its groups, as for its in-process tools. Only a record
  // naming a principal needs auth storage.
  const auth = host.storage.auth
  if (!auth && execution.authorizationRef.type !== "disabled") {
    throw new AgentRunScopeError(
      "auth_unavailable",
      `[Sixb] Agent run '${run.runId}' needs auth storage to resolve its authority.`
    )
  }

  try {
    const authorization = await resolveAuthorization(host, auth, run, execution)
    return {
      execution,
      ...(run.authority.type === "managed" ? { actorId: run.authority.actorId } : {}),
      runId: run.runId,
      authorization,
    }
  } catch (error) {
    throw new AgentRunScopeError(
      "authority_invalid",
      `[Sixb] Agent run '${run.runId}' execution authority is not valid: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

async function resolveAuthorization(
  host: AgentRunScopeHost,
  auth: AuthStorage | undefined,
  run: { readonly runId: string; readonly authority: AgentRunScopeAuthority },
  execution: ExecutionRecord
): Promise<AgentExecutionAuthorization> {
  if (run.authority.type === "inherited") {
    const authorization = await resolveInheritedAgentExecutionAuthorization({
      auth,
      projectId: host.id,
      authorizationRef: execution.authorizationRef,
      security: host.definitions.security,
    })
    assertAgentExecutionRecord({ execution, runId: run.runId, authorization })
    return authorization
  }

  const resolved = await resolveAgentExecutionAuthorization({
    auth,
    projectId: host.id,
    actorId: run.authority.actorId,
    authorizationRef: execution.authorizationRef,
    security: host.definitions.security,
  })
  const authorization = { type: "principal", context: resolved.context } as const
  assertAgentExecutionRecord({
    execution,
    actorId: run.authority.actorId,
    runId: run.runId,
    authorization,
  })
  return authorization
}
