import { SYSTEM_PRINCIPAL } from "../auth"
import type { AuthorizationContext } from "../authorization"
import { resolveAuthorizationContext } from "../authorization"
import type { AuthorizablePrincipal, AuthorizationRef } from "../execution"
import type { SecurityDefinitionCatalog } from "../security"
import type {
  AuthStorage,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
} from "../storage/auth"
import { AuthStorageError } from "../storage/auth"
import type { AgentDefinition } from "./types"

export interface AgentExecutionIdentity {
  readonly serviceAccount: ServiceAccountRecord
  readonly principal: Extract<AuthorizablePrincipal, { readonly type: "serviceAccount" }>
  readonly groupMemberships: readonly ServiceAccountGroupMembershipRecord[]
}

export function agentServiceAccountId(agentId: string): string {
  return `svc_agent_${agentId}`
}

/** Ensure the definition-owned service account exists before an Agent execution is admitted. */
export async function ensureAgentExecutionIdentity(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly agent: AgentDefinition
}): Promise<AgentExecutionIdentity> {
  const auth = requireAuthStorage(input.auth)
  const id = agentServiceAccountId(input.agent.id)
  const name = input.agent.name
  const description = `Managed service account for agent '${input.agent.id}'.`
  const now = new Date()
  const loaded = await loadOrCreateAgentServiceAccount(auth, {
    id,
    projectId: input.projectId,
    name,
    description,
    updatedAt: now,
  })
  assertActiveAgentServiceAccount(input.agent.id, loaded)
  const serviceAccount = await updateAgentServiceAccountMetadata(auth, {
    existing: loaded,
    name,
    description,
    updatedAt: now,
  })
  assertActiveAgentServiceAccount(input.agent.id, serviceAccount)

  const groupMemberships = await auth.serviceAccountGroupMemberships.reconcileForServiceAccount({
    projectId: input.projectId,
    serviceAccountId: id,
    groupIds: input.agent.groupIds,
    source: "agent",
    updatedAt: now,
  })

  return {
    serviceAccount,
    principal: { type: "serviceAccount", id },
    groupMemberships,
  }
}

/** Load the managed identity, recovering only the expected concurrent-create race. */
async function loadOrCreateAgentServiceAccount(
  auth: AuthStorage,
  input: {
    readonly id: string
    readonly projectId: string
    readonly name: string
    readonly description: string
    readonly updatedAt: Date
  }
): Promise<ServiceAccountRecord> {
  const existing = await auth.serviceAccounts.getById({
    projectId: input.projectId,
    id: input.id,
  })
  if (existing) return existing

  try {
    return await auth.serviceAccounts.create({
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      status: "active",
      createdByPrincipal: SYSTEM_PRINCIPAL,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })
  } catch (error) {
    if (!(error instanceof AuthStorageError) || error.code !== "duplicate_service_account") {
      throw error
    }
    const concurrent = await auth.serviceAccounts.getById({
      projectId: input.projectId,
      id: input.id,
    })
    if (!concurrent) throw error
    return concurrent
  }
}

function assertActiveAgentServiceAccount(
  agentId: string,
  serviceAccount: ServiceAccountRecord
): void {
  if (serviceAccount.status === "suspended") {
    throw new Error(
      `[Sixb] Agent '${agentId}' service account '${serviceAccount.id}' is suspended.`
    )
  }
}

/** Resolve current grants for the service account referenced by a durable Agent execution. */
export async function resolveAgentExecutionAuthorization(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly agentId: string
  readonly authorizationRef: AuthorizationRef
  readonly security: SecurityDefinitionCatalog
}): Promise<{ readonly identity: AgentExecutionIdentity; readonly context: AuthorizationContext }> {
  const auth = requireAuthStorage(input.auth)
  const expectedId = agentServiceAccountId(input.agentId)
  const principal =
    input.authorizationRef.type === "principal" ? input.authorizationRef.principal : null
  if (principal?.type !== "serviceAccount" || principal.id !== expectedId) {
    throw new Error(
      `[Sixb] Agent '${input.agentId}' execution authority must reference service account '${expectedId}'.`
    )
  }

  const serviceAccount = await auth.serviceAccounts.getById({
    projectId: input.projectId,
    id: principal.id,
  })
  if (!serviceAccount || serviceAccount.status !== "active") {
    throw new Error(`[Sixb] Agent service account '${principal.id}' is not active.`)
  }

  const groupMemberships = await auth.serviceAccountGroupMemberships.listForServiceAccount({
    projectId: input.projectId,
    serviceAccountId: principal.id,
  })
  const identity: AgentExecutionIdentity = {
    serviceAccount,
    principal: { type: "serviceAccount", id: principal.id },
    groupMemberships,
  }
  return {
    identity,
    context: resolveAuthorizationContext({
      principal: identity.principal,
      groupIds: groupMemberships.map((membership) => membership.groupId),
      roles: input.security.listResolvedRoles(),
    }),
  }
}

function requireAuthStorage(auth: AuthStorage | undefined): AuthStorage {
  if (!auth) {
    throw new Error("[Sixb] Agent executions require auth storage.")
  }
  return auth
}

async function updateAgentServiceAccountMetadata(
  auth: AuthStorage,
  input: {
    readonly existing: ServiceAccountRecord
    readonly name: string
    readonly description: string
    readonly updatedAt: Date
  }
): Promise<ServiceAccountRecord> {
  if (input.existing.name === input.name && input.existing.description === input.description) {
    return input.existing
  }
  return auth.serviceAccounts.update({
    projectId: input.existing.projectId,
    id: input.existing.id,
    name: input.name,
    description: input.description,
    updatedAt: input.updatedAt,
  })
}
