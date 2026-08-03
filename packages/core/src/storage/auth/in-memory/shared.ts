import { type AuthSessionAudience, resolveAuthSessionAudience } from "../../../auth/audience"
import { authStorageError } from "../../../storage/auth/errors"
import type {
  AccessTokenRecord,
  CompleteAuthSessionInput,
  CreateAuthAccessTokenInput,
  CreateAuthServiceAccountInput,
  CreateAuthSessionInput,
  GroupMembershipRecord,
  InvitationRecord,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
  SessionRecord,
  UpsertAuthGroupMembershipInput,
  UpsertAuthServiceAccountGroupMembershipInput,
  UserIdentityRecord,
  UserRecord,
} from "../types"

export interface AuthStorageState {
  readonly users: Map<string, UserRecord>
  readonly identities: Map<string, UserIdentityRecord>
  readonly serviceAccounts: Map<string, ServiceAccountRecord>
  readonly serviceAccountGroupMemberships: Map<string, ServiceAccountGroupMembershipRecord>
  readonly sessions: Map<string, SessionRecord>
  readonly accessTokens: Map<string, AccessTokenRecord>
  readonly invitations: Map<string, InvitationRecord>
  readonly groupMemberships: Map<string, GroupMembershipRecord>
  readonly magicLinks: Map<string, MagicLinkRecord>
  readonly oidcAuthorizationAttempts: Map<string, OidcAuthorizationAttemptRecord>
}

export function createAuthStorageState(): AuthStorageState {
  return {
    users: new Map(),
    identities: new Map(),
    serviceAccounts: new Map(),
    serviceAccountGroupMemberships: new Map(),
    sessions: new Map(),
    accessTokens: new Map(),
    invitations: new Map(),
    groupMemberships: new Map(),
    magicLinks: new Map(),
    oidcAuthorizationAttempts: new Map(),
  }
}

function scopedKey(...parts: readonly string[]): string {
  return JSON.stringify(parts)
}

export function userKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function identityKey(projectId: string, strategyId: string, subject: string): string {
  return scopedKey(projectId, strategyId, subject)
}

export function serviceAccountKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function serviceAccountGroupMembershipKey(
  projectId: string,
  serviceAccountId: string,
  groupId: string
): string {
  return scopedKey(projectId, serviceAccountId, groupId)
}

export function sessionKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function accessTokenKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function invitationKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function groupMembershipKey(projectId: string, userId: string, groupId: string): string {
  return scopedKey(projectId, userId, groupId)
}

export function magicLinkKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function oidcAttemptKey(projectId: string, id: string): string {
  return scopedKey(projectId, id)
}

export function cloneRecord<T>(record: T): T {
  return structuredClone(record)
}

export function cloneOptionalRecord<T>(record: T | null): T | null {
  return record ? cloneRecord(record) : null
}

export function cloneDate(value: Date): Date {
  return new Date(value)
}

export function dateOrNow(value: Date | undefined): Date {
  return value ? cloneDate(value) : new Date()
}

export function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw authStorageError("invalid_input", `[Sixb] ${label} must be a non-empty string.`)
  }
  return normalized
}

export function normalizeEmail(email: string): string {
  return assertNonEmpty(email, "Email").toLowerCase()
}

export function normalizeGroupIds(groupIds: readonly string[] | undefined): readonly string[] {
  return [...new Set((groupIds ?? []).map((groupId) => assertNonEmpty(groupId, "Group id")))]
}

export function normalizeOptionalGroupIds(
  groupIds: readonly string[] | undefined
): readonly string[] | undefined {
  return groupIds === undefined ? undefined : normalizeGroupIds(groupIds)
}

export function normalizeClaims(
  claims: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  return claims ? cloneRecord(claims) : undefined
}

export function compareByCreatedAt<T extends { readonly id: string; readonly createdAt: Date }>(
  a: T,
  b: T,
  order: "asc" | "desc"
): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  return order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

export function isActiveSession(session: SessionRecord, now: Date): boolean {
  return (
    !session.revokedAt &&
    session.expiresAt > now &&
    (!session.absoluteExpiresAt || session.absoluteExpiresAt > now)
  )
}

export function isActiveAccessToken(token: AccessTokenRecord, now: Date): boolean {
  return !token.revokedAt && token.expiresAt > now
}

export function isActiveInvitation(invitation: InvitationRecord, now: Date): boolean {
  return invitation.status === "pending" && invitation.expiresAt > now
}

export function isActiveMagicLink(link: MagicLinkRecord, now: Date): boolean {
  return !link.consumedAt && !link.revokedAt && link.expiresAt > now
}

export function getUserByEmail(
  state: AuthStorageState,
  projectId: string,
  email: string
): UserRecord | null {
  const normalizedEmail = normalizeEmail(email)
  for (const user of state.users.values()) {
    if (user.projectId === projectId && user.email === normalizedEmail) {
      return user
    }
  }
  return null
}

export function getActiveInvitationByEmail(
  state: AuthStorageState,
  projectId: string,
  email: string,
  now: Date
): InvitationRecord | null {
  const normalizedEmail = normalizeEmail(email)
  const invitations = [...state.invitations.values()]
    .filter((invitation) => invitation.projectId === projectId)
    .filter((invitation) => invitation.email === normalizedEmail)
    .filter((invitation) => isActiveInvitation(invitation, now))
    .sort((a, b) => compareByCreatedAt(a, b, "desc"))

  return invitations[0] ?? null
}

export function revokeActiveSessionsForUser(
  state: AuthStorageState,
  projectId: string,
  userId: string,
  revokedAt: Date,
  audience?: AuthSessionAudience
): readonly SessionRecord[] {
  const revoked: SessionRecord[] = []

  for (const [key, session] of state.sessions) {
    if (session.projectId !== projectId || session.userId !== userId) {
      continue
    }

    if (audience !== undefined && session.audience !== audience) {
      continue
    }

    if (!isActiveSession(session, revokedAt)) {
      continue
    }

    const next: SessionRecord = {
      ...session,
      revokedAt: cloneDate(revokedAt),
    }
    state.sessions.set(key, cloneRecord(next))
    revoked.push(next)
  }

  return revoked
}

export function revokeActiveMagicLinksForEmail(
  state: AuthStorageState,
  projectId: string,
  email: string,
  revokedAt: Date
): readonly MagicLinkRecord[] {
  const normalizedEmail = normalizeEmail(email)
  const revoked: MagicLinkRecord[] = []

  for (const [key, link] of state.magicLinks) {
    if (link.projectId !== projectId || link.email !== normalizedEmail) {
      continue
    }

    if (!isActiveMagicLink(link, revokedAt)) {
      continue
    }

    const next: MagicLinkRecord = {
      ...link,
      revokedAt: cloneDate(revokedAt),
    }
    state.magicLinks.set(key, cloneRecord(next))
    revoked.push(next)
  }

  return revoked
}

export function assertSessionIdAvailable(
  state: AuthStorageState,
  projectId: string,
  sessionId: string
): void {
  if (state.sessions.has(sessionKey(projectId, sessionId))) {
    throw authStorageError(
      "duplicate_session",
      `[Sixb] Session '${sessionId}' already exists for project '${projectId}'.`
    )
  }
}

export function validateCompleteSessionInput(
  state: AuthStorageState,
  projectId: string,
  session: CompleteAuthSessionInput
): void {
  const sessionId = assertNonEmpty(session.id, "Session id")
  assertNonEmpty(session.audience, "Session audience")
  assertNonEmpty(session.tokenHash, "Session token hash")
  assertSessionIdAvailable(state, projectId, sessionId)
}

export function createSessionRecord(
  state: AuthStorageState,
  input: CreateAuthSessionInput
): SessionRecord {
  const id = assertNonEmpty(input.id, "Session id")
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
  const audience = resolveAuthSessionAudience(input.audience)
  const tokenHash = assertNonEmpty(input.tokenHash, "Session token hash")

  assertSessionIdAvailable(state, projectId, id)

  const session: SessionRecord = {
    id,
    projectId,
    userId,
    strategyId,
    audience,
    tokenHash,
    createdAt: cloneDate(input.createdAt),
    expiresAt: cloneDate(input.expiresAt),
    absoluteExpiresAt: input.absoluteExpiresAt ? cloneDate(input.absoluteExpiresAt) : undefined,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  }

  state.sessions.set(sessionKey(projectId, id), cloneRecord(session))
  return session
}

export function createServiceAccountRecord(
  state: AuthStorageState,
  input: CreateAuthServiceAccountInput
): ServiceAccountRecord {
  const id = assertNonEmpty(input.id, "Service account id")
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const name = assertNonEmpty(input.name, "Service account name")
  const key = serviceAccountKey(projectId, id)

  if (state.serviceAccounts.has(key)) {
    throw authStorageError(
      "duplicate_service_account",
      `[Sixb] Service account '${id}' already exists for project '${projectId}'.`
    )
  }

  const createdAt = dateOrNow(input.createdAt)
  const serviceAccount: ServiceAccountRecord = {
    id,
    projectId,
    name,
    description: input.description,
    status: input.status ?? "active",
    createdByPrincipal: input.createdByPrincipal,
    createdBySessionId: input.createdBySessionId,
    createdAt,
    updatedAt: input.updatedAt ? cloneDate(input.updatedAt) : cloneDate(createdAt),
  }

  state.serviceAccounts.set(key, cloneRecord(serviceAccount))
  return serviceAccount
}

export function upsertServiceAccountGroupMembershipRecord(
  state: AuthStorageState,
  input: UpsertAuthServiceAccountGroupMembershipInput
): ServiceAccountGroupMembershipRecord {
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const serviceAccountId = assertNonEmpty(input.serviceAccountId, "Service account id")
  const groupId = assertNonEmpty(input.groupId, "Group id")
  if (!state.serviceAccounts.has(serviceAccountKey(projectId, serviceAccountId))) {
    throw authStorageError(
      "missing_service_account",
      `[Sixb] Service account '${serviceAccountId}' not found for project '${projectId}'.`
    )
  }

  const key = serviceAccountGroupMembershipKey(projectId, serviceAccountId, groupId)
  const existing = state.serviceAccountGroupMemberships.get(key)
  if (existing) {
    return existing
  }

  const membership: ServiceAccountGroupMembershipRecord = {
    projectId,
    serviceAccountId,
    groupId,
    source: input.source,
    createdAt: dateOrNow(input.createdAt),
  }

  state.serviceAccountGroupMemberships.set(key, cloneRecord(membership))
  return membership
}

export function createAccessTokenRecord(
  state: AuthStorageState,
  input: CreateAuthAccessTokenInput
): AccessTokenRecord {
  const id = assertNonEmpty(input.id, "Access token id")
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const name = assertNonEmpty(input.name, "Access token name")
  const subjectId = assertNonEmpty(input.subjectId, "Access token subject id")
  const tokenHash = assertNonEmpty(input.tokenHash, "Access token hash")

  assertAccessTokenSubject(input.kind, input.subjectType)
  assertAccessTokenSubjectExists(state, projectId, input.subjectType, subjectId)

  const key = accessTokenKey(projectId, id)
  if (state.accessTokens.has(key)) {
    throw authStorageError(
      "duplicate_access_token",
      `[Sixb] Access token '${id}' already exists for project '${projectId}'.`
    )
  }

  const token: AccessTokenRecord = {
    id,
    projectId,
    name,
    kind: input.kind,
    subjectType: input.subjectType,
    subjectId,
    tokenHash,
    groupIds: normalizeOptionalGroupIds(input.groupIds),
    createdByPrincipal: input.createdByPrincipal,
    createdBySessionId: input.createdBySessionId,
    createdAt: cloneDate(input.createdAt),
    expiresAt: cloneDate(input.expiresAt),
  }

  state.accessTokens.set(key, cloneRecord(token))
  return token
}

export function upsertGroupMembershipRecord(
  state: AuthStorageState,
  input: UpsertAuthGroupMembershipInput
): GroupMembershipRecord {
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const groupId = assertNonEmpty(input.groupId, "Group id")
  if (!state.users.has(userKey(projectId, userId))) {
    throw authStorageError(
      "missing_user",
      `[Sixb] User '${userId}' not found for project '${projectId}'.`
    )
  }

  const key = groupMembershipKey(projectId, userId, groupId)
  const existing = state.groupMemberships.get(key)

  if (existing) {
    return existing
  }

  const membership: GroupMembershipRecord = {
    projectId,
    userId,
    groupId,
    source: input.source,
    createdAt: dateOrNow(input.createdAt),
  }

  state.groupMemberships.set(key, cloneRecord(membership))
  return membership
}

export function removeGroupMembershipRecord(
  state: AuthStorageState,
  params: { readonly projectId: string; readonly userId: string; readonly groupId: string }
): GroupMembershipRecord | null {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const userId = assertNonEmpty(params.userId, "User id")
  const groupId = assertNonEmpty(params.groupId, "Group id")

  const key = groupMembershipKey(projectId, userId, groupId)
  const existing = state.groupMemberships.get(key)
  if (!existing) {
    return null
  }

  state.groupMemberships.delete(key)
  return existing
}

function assertAccessTokenSubject(
  kind: CreateAuthAccessTokenInput["kind"],
  subjectType: CreateAuthAccessTokenInput["subjectType"]
): void {
  if (
    (kind === "personal" && subjectType === "user") ||
    (kind === "serviceAccount" && subjectType === "serviceAccount")
  ) {
    return
  }

  throw authStorageError(
    "invalid_input",
    `[Sixb] Access token kind '${kind}' cannot target subject type '${subjectType}'.`
  )
}

function assertAccessTokenSubjectExists(
  state: AuthStorageState,
  projectId: string,
  subjectType: CreateAuthAccessTokenInput["subjectType"],
  subjectId: string
): void {
  if (subjectType === "user") {
    if (state.users.has(userKey(projectId, subjectId))) return
    throw authStorageError(
      "missing_user",
      `[Sixb] User '${subjectId}' not found for project '${projectId}'.`
    )
  }

  if (state.serviceAccounts.has(serviceAccountKey(projectId, subjectId))) return
  throw authStorageError(
    "missing_service_account",
    `[Sixb] Service account '${subjectId}' not found for project '${projectId}'.`
  )
}

export function consumeMagicLinkRecord(
  state: AuthStorageState,
  params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }
): MagicLinkRecord {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const id = assertNonEmpty(params.id, "Magic link id")
  const tokenHash = assertNonEmpty(params.tokenHash, "Magic link token hash")
  const key = magicLinkKey(projectId, id)
  const existing = state.magicLinks.get(key)

  if (!existing) {
    throw authStorageError(
      "missing_magic_link",
      `[Sixb] Magic link '${id}' not found for project '${projectId}'.`
    )
  }

  if (existing.tokenHash !== tokenHash || existing.consumedAt || existing.revokedAt) {
    throw authStorageError(
      "invalid_magic_link",
      `[Sixb] Magic link '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (existing.expiresAt <= params.consumedAt) {
    throw authStorageError(
      "expired_magic_link",
      `[Sixb] Magic link '${id}' is expired for project '${projectId}'.`
    )
  }

  const consumed: MagicLinkRecord = {
    ...existing,
    consumedAt: cloneDate(params.consumedAt),
  }
  state.magicLinks.set(key, cloneRecord(consumed))
  return consumed
}

export function consumeOidcAttemptRecord(
  state: AuthStorageState,
  params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }
): OidcAuthorizationAttemptRecord {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const id = assertNonEmpty(params.id, "OIDC authorization attempt id")
  const stateHash = assertNonEmpty(params.stateHash, "OIDC state hash")
  const key = oidcAttemptKey(projectId, id)
  const existing = state.oidcAuthorizationAttempts.get(key)

  if (!existing) {
    throw authStorageError(
      "missing_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' not found for project '${projectId}'.`
    )
  }

  if (existing.stateHash !== stateHash || existing.consumedAt) {
    throw authStorageError(
      "invalid_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (existing.expiresAt <= params.consumedAt) {
    throw authStorageError(
      "expired_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is expired for project '${projectId}'.`
    )
  }

  const consumed: OidcAuthorizationAttemptRecord = {
    ...existing,
    consumedAt: cloneDate(params.consumedAt),
  }
  state.oidcAuthorizationAttempts.set(key, cloneRecord(consumed))
  return consumed
}
