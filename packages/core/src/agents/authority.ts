import { SYSTEM_PRINCIPAL } from "../auth"
import { normalizeRequesterGroupIds } from "../auth/attribution"
import { principalsEqual } from "../auth/types"
import type { AuthorizationContext } from "../authorization"
import { resolveAuthorizationContext } from "../authorization"
import type { AuthorizablePrincipal, AuthorizationRef } from "../execution"
import type { SecurityDefinitionCatalog } from "../security"
import type { AgentRunRecord } from "../storage/agents"
import type {
  AuthStorage,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
} from "../storage/auth"
import { AuthStorageError } from "../storage/auth"
import type { ExecutionRecord } from "../storage/executions"
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

export interface ResolveRequesterAuthorizationInput {
  /** The run's immutable execution, which carries the originating human in `requestedBy`. */
  readonly execution: ExecutionRecord
  /** The run, which carries the effective authorization groups snapshotted at admission. */
  readonly run: Pick<AgentRunRecord, "requesterAuthorizationGroupIds">
  readonly security: SecurityDefinitionCatalog
}

/**
 * Rebuild the authority of the human an Agent run acts for.
 *
 * Groups come from the run's `requesterAuthorizationGroupIds` — the *constrained* snapshot taken at
 * admission — while roles resolve live, so a role edit takes effect without re-admitting the run.
 * `requesterGroupIds` must never be substituted: it is deliberately the principal's full membership
 * (see `snapshotRequesterGroupIds`), so using it would re-inflate a group-scoped access token back
 * to full authority.
 *
 * Returns `null` when the run has no human requester. Callers must treat that as a denial, never as
 * an absent check — `evaluate(undefined, ...)` reports `allowed: true`.
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

export interface AgentRunAuthorization {
  readonly context: AuthorizationContext
  /** The identity the run executes as: its own service account, or the human it acts for. */
  readonly principal: AuthorizablePrincipal
}

/**
 * Resolve the authority one durable Agent run executes under.
 *
 * The record decides which of two shapes applies:
 *
 * - **Own identity** — the default. Grants resolve live from the service account's current
 *   memberships, so a group change takes effect on the next turn.
 * - **Delegated** — the run acts as its requester, which is how the framework-managed main agent
 *   reaches exactly what its user can reach without holding groups of its own. See
 *   {@link resolveRequesterAuthorization} for why the snapshot, not live memberships, is the basis.
 *
 * A delegated run whose requester has since been suspended is refused: the snapshot fixes the
 * caller's reach, not their continued existence.
 */
export async function resolveAgentRunAuthorization(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly agentId: string
  readonly execution: ExecutionRecord
  readonly run: Pick<AgentRunRecord, "requesterAuthorizationGroupIds">
  readonly security: SecurityDefinitionCatalog
}): Promise<AgentRunAuthorization> {
  const auth = requireAuthStorage(input.auth)
  const authority = input.execution.authorizationRef
  if (authority.type !== "principal") {
    throw new Error(`[Sixb] Agent '${input.agentId}' execution requires principal authority.`)
  }

  if (
    authority.principal.type === "serviceAccount" &&
    authority.principal.id === agentServiceAccountId(input.agentId)
  ) {
    const resolved = await resolveAgentExecutionAuthorization({
      auth,
      projectId: input.projectId,
      agentId: input.agentId,
      authorizationRef: authority,
      security: input.security,
    })
    return { context: resolved.context, principal: resolved.identity.principal }
  }

  // Anything that is not the agent's own account must be exactly its requester. `withScope` checks
  // this again against the durable record, but this function is reachable on its own, so it does
  // not rely on a caller running that check afterwards.
  const requestedBy = input.execution.requestedBy
  const context = resolveRequesterAuthorization({
    execution: input.execution,
    run: input.run,
    security: input.security,
  })
  if (!context || !requestedBy || !principalsEqual(authority.principal, requestedBy)) {
    throw new Error(
      `[Sixb] Agent '${input.agentId}' delegated authority must reference its requested-by principal.`
    )
  }
  await assertRequesterStillActive(auth, input.projectId, requestedBy)
  return { context, principal: requestedBy }
}

/** Refuse a delegated run whose requester was suspended or removed after admission. */
async function assertRequesterStillActive(
  auth: AuthStorage,
  projectId: string,
  principal: AuthorizablePrincipal
): Promise<void> {
  const record =
    principal.type === "user"
      ? await auth.users.getById({ projectId, id: principal.id })
      : await auth.serviceAccounts.getById({ projectId, id: principal.id })
  if (!record || record.status !== "active") {
    throw new Error(`[Sixb] Requester '${principal.id}' is no longer active for this project.`)
  }
}
