import { principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import type { AuthorizationContext } from "../authorization"
import { resolveAuthorizationContext } from "../authorization"
import { createSixbError } from "../errors/internal"
import type { AuthorizablePrincipal, AuthorizationRef } from "../execution"
import type { SecurityDefinitionCatalog } from "../security"
import type {
  AccessTokenRecord,
  AuthStorage,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
  SessionRecord,
  UserRecord,
} from "../storage/auth"
import { AuthStorageError } from "../storage/auth"
import type { AgentDefinition } from "./types"

export type AgentExecutionAuthorization =
  | { readonly type: "principal"; readonly context: AuthorizationContext }
  | { readonly type: "disabled" }

type UserCredentialRef = NonNullable<
  Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
>

interface CredentialedUserAuthorizationRef {
  readonly type: "principal"
  readonly principal: Extract<AuthorizablePrincipal, { readonly type: "user" }>
  readonly credential: UserCredentialRef
}

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
  return ensureManagedAgentExecutionIdentity({
    auth: input.auth,
    projectId: input.projectId,
    agentId: input.agent.id,
    name: input.agent.name,
    description: `Managed service account for agent '${input.agent.id}'.`,
    groupIds: input.agent.groupIds,
  })
}

/** Ensure a framework-managed Agent actor exists with exactly its declared group memberships. */
export async function ensureManagedAgentExecutionIdentity(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly agentId: string
  readonly name: string
  readonly description: string
  readonly groupIds: readonly string[]
}): Promise<AgentExecutionIdentity> {
  const auth = requireAuthStorage(input.auth)
  const id = agentServiceAccountId(input.agentId)
  const now = new Date()
  const loaded = await loadOrCreateAgentServiceAccount(auth, {
    id,
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    updatedAt: now,
  })
  assertFrameworkManagedAgentServiceAccount(input.agentId, loaded)
  assertActiveAgentServiceAccount(input.agentId, loaded)
  const serviceAccount = await updateAgentServiceAccountMetadata(auth, {
    existing: loaded,
    name: input.name,
    description: input.description,
    updatedAt: now,
  })
  assertActiveAgentServiceAccount(input.agentId, serviceAccount)

  const groupMemberships = requireDefinitionOwnedGroupMemberships(
    input.agentId,
    await auth.serviceAccountGroupMemberships.reconcileForServiceAccount({
      projectId: input.projectId,
      serviceAccountId: id,
      groupIds: input.groupIds,
      source: "agent",
      updatedAt: now,
    })
  )

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

function assertFrameworkManagedAgentServiceAccount(
  agentId: string,
  serviceAccount: ServiceAccountRecord
): void {
  if (
    serviceAccount.createdByPrincipal === undefined ||
    !principalsEqual(serviceAccount.createdByPrincipal, SYSTEM_PRINCIPAL)
  ) {
    throw createSixbError(
      "agent.execution_failed",
      `[Sixb] Agent '${agentId}' cannot use service account '${serviceAccount.id}' because it is not managed by Sixb.`,
      { details: { agentId, serviceAccountId: serviceAccount.id } }
    )
  }
}

function requireDefinitionOwnedGroupMemberships(
  agentId: string,
  memberships: readonly ServiceAccountGroupMembershipRecord[]
): readonly ServiceAccountGroupMembershipRecord[] {
  const externalGroupIds = memberships
    .filter((membership) => membership.source !== "agent")
    .map((membership) => membership.groupId)
  if (externalGroupIds.length > 0) {
    throw createSixbError(
      "agent.execution_failed",
      `[Sixb] Agent '${agentId}' service account has group memberships not managed by its definition: ${externalGroupIds.join(", ")}.`,
      { details: { agentId, externalGroupIds } }
    )
  }
  return memberships
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
  assertFrameworkManagedAgentServiceAccount(input.agentId, serviceAccount)

  const groupMemberships = requireDefinitionOwnedGroupMemberships(
    input.agentId,
    await auth.serviceAccountGroupMemberships.listForServiceAccount({
      projectId: input.projectId,
      serviceAccountId: principal.id,
    })
  )
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

/** Revalidate the durable user authority inherited by the framework-owned main Agent. */
export async function resolveInheritedMainAgentExecutionAuthorization(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly authorizationRef: AuthorizationRef
  readonly security: SecurityDefinitionCatalog
  readonly now?: Date
}): Promise<AgentExecutionAuthorization> {
  if (input.authorizationRef.type === "disabled") return { type: "disabled" }

  const ref = requireCredentialedUserAuthority(input.authorizationRef)
  const auth = requireAuthStorage(input.auth)
  const now = input.now ?? new Date()
  const user = await requireActiveUser(auth, input.projectId, ref.principal.id)
  const memberships = await auth.groupMemberships.listForUser({
    projectId: input.projectId,
    userId: user.id,
  })
  const credential = await revalidateUserCredential({
    auth,
    projectId: input.projectId,
    userId: user.id,
    credential: ref.credential,
    currentGroupIds: memberships.map((membership) => membership.groupId),
    now,
  })

  return {
    type: "principal",
    context: resolveAuthorizationContext({
      principal: ref.principal,
      groupIds: credential.groupIds,
      roles: input.security.listResolvedRoles(),
      ...(credential.sessionId === undefined ? {} : { sessionId: credential.sessionId }),
    }),
  }
}

function requireCredentialedUserAuthority(ref: AuthorizationRef): CredentialedUserAuthorizationRef {
  if (ref.type !== "principal" || ref.principal.type !== "user" || ref.credential === undefined) {
    throw invalidInheritedAuthority("the durable reference is not a credentialed user")
  }
  return {
    type: "principal",
    principal: { type: "user", id: ref.principal.id },
    credential: { type: ref.credential.type, id: ref.credential.id },
  }
}

async function requireActiveUser(
  auth: AuthStorage,
  projectId: string,
  userId: string
): Promise<UserRecord> {
  const user = await auth.users.getById({ projectId, id: userId })
  if (!user || user.status !== "active") {
    throw invalidInheritedAuthority(`user '${userId}' is not active`)
  }
  return user
}

async function revalidateUserCredential(input: {
  readonly auth: AuthStorage
  readonly projectId: string
  readonly userId: string
  readonly credential: UserCredentialRef
  readonly currentGroupIds: readonly string[]
  readonly now: Date
}): Promise<{ readonly groupIds: readonly string[]; readonly sessionId?: string }> {
  if (input.credential.type === "session") {
    const session = await input.auth.sessions.getById({
      projectId: input.projectId,
      id: input.credential.id,
    })
    if (!isUsableUserSession(session, input.userId, input.now)) {
      throw invalidInheritedAuthority("the inherited session is no longer valid")
    }
    return { groupIds: input.currentGroupIds, sessionId: session.id }
  }

  const accessToken = await input.auth.accessTokens.getById({
    projectId: input.projectId,
    id: input.credential.id,
  })
  if (!isUsableUserAccessToken(accessToken, input.userId, input.now)) {
    throw invalidInheritedAuthority("the inherited access token is no longer valid")
  }
  if (accessToken.groupIds === undefined) return { groupIds: input.currentGroupIds }

  const allowedGroupIds = new Set(accessToken.groupIds)
  return {
    groupIds: input.currentGroupIds.filter((groupId) => allowedGroupIds.has(groupId)),
  }
}

function isUsableUserSession(
  session: SessionRecord | null,
  userId: string,
  now: Date
): session is SessionRecord {
  if (!session || session.userId !== userId || session.revokedAt !== undefined) return false
  if (session.expiresAt.getTime() <= now.getTime()) return false
  return (
    session.absoluteExpiresAt === undefined || session.absoluteExpiresAt.getTime() > now.getTime()
  )
}

function isUsableUserAccessToken(
  token: AccessTokenRecord | null,
  userId: string,
  now: Date
): token is AccessTokenRecord {
  if (!token || token.subjectType !== "user" || token.subjectId !== userId) return false
  return token.revokedAt === undefined && token.expiresAt.getTime() > now.getTime()
}

function invalidInheritedAuthority(reason: string): Error {
  return createSixbError(
    "agent.execution_failed",
    `[Sixb] The main Agent execution cannot restore its inherited authority: ${reason}.`
  )
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
