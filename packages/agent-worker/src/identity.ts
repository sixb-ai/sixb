import type {
  AccessTokenRecord,
  AgentDefinition,
  AgentRunRecord,
  Principal,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
} from "@sixb/core"
import { createAccessTokenCredential } from "@sixb/core"
import type { AgentWorkerStorage } from "./types"

const SYSTEM_PRINCIPAL: Principal = { type: "system", id: "agent-worker" }

// Token TTL knobs: 5 minute safety buffer, 15 minute minimum, 1 hour maximum.
const TOKEN_TTL_SAFETY_MS = 5 * 60_000
const MIN_TOKEN_TTL_MS = 15 * 60_000
const MAX_TOKEN_TTL_MS = 60 * 60_000

/** Stable auth identity the worker uses when an agent acts on Sixb resources. */
export interface AgentExecutionIdentity {
  readonly serviceAccount: ServiceAccountRecord
  readonly principal: Extract<Principal, { readonly type: "serviceAccount" }>
  readonly groupMemberships: readonly ServiceAccountGroupMembershipRecord[]
}

/** Persisted token metadata plus the raw bearer value, which is only available at mint time. */
export interface AgentRunAccessToken {
  readonly accessToken: AccessTokenRecord
  readonly tokenValue: string
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
        createdByPrincipal: SYSTEM_PRINCIPAL,
        createdAt: now,
        updatedAt: now,
      })

  // Agent-owned memberships should exactly match the current definition. The
  // store preserves manual memberships while pruning stale memberships whose
  // source is "agent".
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

export async function mintAgentRunAccessToken(input: {
  readonly storage: AgentWorkerStorage
  readonly projectId: string
  readonly agent: AgentDefinition
  readonly run: AgentRunRecord
  readonly turnTimeoutMs: number
}): Promise<AgentRunAccessToken> {
  const serviceAccountId = agentServiceAccountId(input.agent)
  const credential = createAccessTokenCredential("serviceAccount")
  const createdAt = new Date()
  // Token values are returned once and only the hash is stored. The worker hands
  // the raw value to tools that need to call Sixb APIs during this run.
  const accessToken = await input.storage.auth.accessTokens.create({
    id: credential.tokenId,
    projectId: input.projectId,
    name: `Agent run ${input.run.id}`,
    kind: "serviceAccount",
    subjectType: "serviceAccount",
    subjectId: serviceAccountId,
    tokenHash: credential.tokenHash,
    groupIds: input.agent.groupIds,
    createdByPrincipal: SYSTEM_PRINCIPAL,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + defaultAgentRunTokenTtlMs(input.turnTimeoutMs)),
  })

  return { accessToken, tokenValue: credential.tokenValue }
}

export async function revokeAgentRunAccessToken(input: {
  readonly storage: AgentWorkerStorage
  readonly projectId: string
  readonly tokenId: string
}): Promise<void> {
  // Normal completion revokes the per-run token. Expiry is still the fallback if
  // the process crashes before cleanup.
  await input.storage.auth.accessTokens.revoke({
    projectId: input.projectId,
    id: input.tokenId,
    revokedAt: new Date(),
  })
}

export function defaultAgentRunTokenTtlMs(turnTimeoutMs: number): number {
  // Give cleanup a small buffer beyond the turn timeout, but cap the blast radius
  // if the worker dies before revoking the token.
  const requested = Math.max(turnTimeoutMs + TOKEN_TTL_SAFETY_MS, MIN_TOKEN_TTL_MS)
  return Math.min(requested, MAX_TOKEN_TTL_MS)
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
