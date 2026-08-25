import { randomUUID } from "node:crypto"
import type { Principal } from "../auth"
import { normalizeRequesterGroupIds } from "../auth/attribution"
import { type AuthorizationContext, isAllowed, resolveAuthorizationContext } from "../authorization"
import { createAgentExecutionRecord } from "../execution/agent"
import type { SecurityDefinitionCatalog } from "../security"
import type { AgentRunRecord, AgentStorage } from "../storage/agents"
import type { ExecutionRecord } from "../storage/executions"
import type { Storage } from "../storage/types"
import { ensureAgentExecutionIdentity, resolveAgentExecutionAuthorization } from "./authority"
import { AgentRequestError } from "./errors"
import {
  createAgentMessageId,
  createAgentRunExecutionToken,
  createAgentRunId,
  createAgentThreadId,
} from "./ids"
import { MAIN_AGENT_ID } from "./main-agent"
import type { AgentDefinition } from "./types"

export interface ResolveRequesterAuthorizationInput {
  /** The parent run's immutable execution, which carries the originating human in `requestedBy`. */
  readonly execution: ExecutionRecord
  /** The parent run, which carries the effective authorization groups snapshotted at admission. */
  readonly run: AgentRunRecord
  readonly security: SecurityDefinitionCatalog
}

/**
 * Rebuild the requester's authority for work an agent delegates on their behalf.
 *
 * Groups come from the run's `requesterAuthorizationGroupIds` — the *constrained* snapshot — while
 * roles resolve live, so a role edit takes effect without re-admitting the run. Returns `null` when
 * the run has no human requester; callers must treat that as a denial, never as an absent check.
 */
export function resolveRequesterAuthorization(
  input: ResolveRequesterAuthorizationInput
): AuthorizationContext | null {
  const requestedBy = input.execution.requestedBy
  if (!requestedBy) {
    return null
  }
  return resolveAuthorizationContext({
    principal: requestedBy,
    groupIds: normalizeRequesterGroupIds(input.run.requesterAuthorizationGroupIds),
    roles: input.security.listResolvedRoles(),
  })
}

export interface RequestSubAgentRunInput {
  readonly storage: Storage
  readonly projectId: string
  readonly security: SecurityDefinitionCatalog
  /** The agent being delegated to. */
  readonly agent: AgentDefinition
  /** The delegating run's immutable execution; becomes the child's `source.executionId`. */
  readonly parentExecution: ExecutionRecord
  /** The delegating run, read for its constrained requester snapshot. */
  readonly parentRun: AgentRunRecord
  /** The task handed to the child, persisted as the trigger message on its thread. */
  readonly prompt: string
  /**
   * Owner of the child's thread. The delegating agent's service account, so the thread stays out of
   * the requester's own thread list (`threads.list` filters on `ownerPrincipal`).
   */
  readonly ownerPrincipal: Principal
  /** Bounds the child's execution token, mirroring the delegating run's queue lease. */
  readonly queueLeaseExpiresAt: Date
}

export interface RequestSubAgentRunResult {
  readonly run: AgentRunRecord
  readonly execution: ExecutionRecord
  readonly threadId: string
}

/**
 * Admit one delegated agent run and hand it back already `running`.
 *
 * Deliberately unlike {@link requestAgentRun} in two ways:
 *
 * - **It never publishes a queue job.** The caller executes this run in its own worker slot. A run
 *   left `queued` would be picked up by `dispatchQueuedAgentRuns`, which scans every queued run, and
 *   then started a second time or reclaimed out from under the in-process turn. Creating and
 *   starting inside one transaction means the scan never observes it. A parent that dies *before*
 *   this commits leaves nothing behind; one that dies after leaves a `running` orphan (see
 *   `docs/agents/main-agent.md`).
 * - **It authorizes against the requester, not the caller.** The delegating agent's own service
 *   account intentionally holds no grants, so the reachable set is the requester's.
 */
export async function requestSubAgentRun(
  input: RequestSubAgentRunInput
): Promise<RequestSubAgentRunResult> {
  const { projectId, agent } = input

  // Structural, not incidental: the main agent is the only agent given `sub_agent`, so refusing it
  // as a target here is what bounds delegation depth at one. Reported as `agent_not_found` so a
  // denied target is indistinguishable from an unknown one, matching the HTTP catalog's rule.
  if (agent.id === MAIN_AGENT_ID) {
    throw new AgentRequestError("agent_not_found", `[Sixb] Unknown agent '${agent.id}'.`)
  }

  const requester = resolveRequesterAuthorization({
    execution: input.parentExecution,
    run: input.parentRun,
    security: input.security,
  })
  // `evaluate(undefined, ...)` reports `allowed: true` — that is the trusted-primitive convention
  // (`authorization/decision.ts:99-109`). A run with no human requester must therefore be denied
  // explicitly; folding this into `isAllowed(requester, ...)` would turn the check into a bypass.
  if (!requester || !isAllowed(requester, { kind: "agent.run", agentId: agent.id })) {
    throw new AgentRequestError("agent_not_found", `[Sixb] Unknown agent '${agent.id}'.`)
  }

  const identity = await ensureAgentExecutionIdentity({
    auth: input.storage.auth,
    projectId,
    agent,
  })
  const resolved = await resolveAgentExecutionAuthorization({
    auth: input.storage.auth,
    projectId,
    agentId: agent.id,
    authorizationRef: { type: "principal", principal: identity.principal },
    security: input.security,
  })

  const runId = createAgentRunId()
  const threadId = createAgentThreadId()
  const triggerMessageId = createAgentMessageId()
  // The parent execution is already durable (its worker loaded it), so it is the parent directly —
  // no `ensureExecutionRecord` round-trip is needed on this path.
  const durableExecution = createAgentExecutionRecord({
    id: `exec_${randomUUID()}`,
    parent: input.parentExecution,
    agentId: agent.id,
    runId,
    principal: resolved.identity.principal,
  })

  const admitted = await input.storage.transaction(async (tx) => {
    const agents = requireAgentStorage(tx.agents)
    const execution = await tx.executions.create(durableExecution)
    await agents.threads.create({
      id: threadId,
      projectId,
      agentId: agent.id,
      ownerPrincipal: input.ownerPrincipal,
    })
    await agents.messages.append({
      id: triggerMessageId,
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: input.prompt }],
      authorPrincipal: input.ownerPrincipal,
    })
    await agents.runs.create({
      id: runId,
      projectId,
      executionId: durableExecution.id,
      threadId,
      agentId: agent.id,
      triggerMessageId,
      requesterGroupIds: input.parentRun.requesterGroupIds,
      requesterAuthorizationGroupIds: input.parentRun.requesterAuthorizationGroupIds,
    })
    const run = await agents.runs.start({
      projectId,
      id: runId,
      modelId: agent.model.modelId,
      execution: {
        token: createAgentRunExecutionToken(),
        queueLeaseExpiresAt: input.queueLeaseExpiresAt,
      },
    })
    return { run, execution }
  })

  return { ...admitted, threadId }
}

function requireAgentStorage(agents: AgentStorage | undefined): AgentStorage {
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return agents
}
