import type { AgentDefinition, Principal } from "@sixb/core"
import type { ServiceAccountGroupMembershipRecord, ServiceAccountRecord } from "@sixb/core/storage"
import type { AgentWorkerStorage } from "./types"

/**
 * Audit identity recorded as the creator of agent-managed service accounts. It is the worker's own
 * system identity, kept distinct from the generic core `SYSTEM_PRINCIPAL` so audit trails attribute
 * these accounts to the agent worker rather than to "system" at large.
 */
const AGENT_WORKER_PRINCIPAL: Principal = { type: "system", id: "agent-worker" }

/** Stable auth identity the worker uses when an agent acts on Sixb resources. */
export interface AgentExecutionIdentity {
  readonly serviceAccount: ServiceAccountRecord
  readonly principal: Extract<Principal, { readonly type: "serviceAccount" }>
  readonly groupMemberships: readonly ServiceAccountGroupMembershipRecord[]
}

export function agentServiceAccountId(agent: AgentDefinition): string {
  return `svc_agent_${agent.id}`
}

export async function reconcileAgentExecutionIdentities(
  storage: AgentWorkerStorage,
  projectId: string,
  agents: readonly AgentDefinition[]
): Promise<readonly AgentExecutionIdentity[]> {
  // Startup reconciliation catches bad or stale managed identities before the
  // worker starts claiming jobs. Each claim reconciles lazily too, so a worker
  // can recover from partial startup or missed deploy-time setup.
  const identities: AgentExecutionIdentity[] = []
  for (const agent of agents) {
    identities.push(await reconcileAgentExecutionIdentity(storage, projectId, agent))
  }
  return identities
}

export async function reconcileAgentExecutionIdentity(
  storage: AgentWorkerStorage,
  projectId: string,
  agent: AgentDefinition
): Promise<AgentExecutionIdentity> {
  const auth = storage.auth
  const serviceAccountId = agentServiceAccountId(agent)
  const name = agent.name
  const description = `Managed service account for agent '${agent.id}'.`
  const now = new Date()
  // The service account is durable and stable across runs. Runs get short-lived
  // tokens, but attribution points back to this managed principal.
  const existing = await auth.serviceAccounts.getById({ projectId, id: serviceAccountId })
  const serviceAccount = existing
    ? await reconcileExistingServiceAccount(storage, {
        projectId,
        id: serviceAccountId,
        existing,
        name,
        description,
        updatedAt: now,
      })
    : await auth.serviceAccounts.create({
        id: serviceAccountId,
        projectId,
        name,
        description,
        status: "active",
        createdByPrincipal: AGENT_WORKER_PRINCIPAL,
        createdAt: now,
        updatedAt: now,
      })

  // Agent-owned memberships should exactly match the current definition. The server-side API
  // gateway uses this durable identity plus a run execution capability to authorize sandbox calls.
  const groupMemberships = await auth.serviceAccountGroupMemberships.reconcileForServiceAccount({
    projectId,
    serviceAccountId,
    groupIds: agent.groupIds,
    source: "agent",
    updatedAt: now,
  })

  return {
    serviceAccount,
    principal: { type: "serviceAccount", id: serviceAccountId },
    groupMemberships,
  }
}

async function reconcileExistingServiceAccount(
  storage: AgentWorkerStorage,
  input: {
    readonly projectId: string
    readonly id: string
    readonly existing: ServiceAccountRecord
    readonly name: string
    readonly description: string
    readonly updatedAt: Date
  }
): Promise<ServiceAccountRecord> {
  // Agent definitions own the display metadata and should reactivate their
  // managed account if an earlier cleanup or operator action suspended it.
  if (
    input.existing.name === input.name &&
    input.existing.description === input.description &&
    input.existing.status === "active"
  ) {
    return input.existing
  }

  return storage.auth.serviceAccounts.update({
    projectId: input.projectId,
    id: input.id,
    name: input.name,
    description: input.description,
    status: "active",
    updatedAt: input.updatedAt,
  })
}
