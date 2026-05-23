import { AuthStorageError } from "../errors"
import type {
  CompleteAuthSessionInput,
  CreateAuthSessionInput,
  GroupMembershipRecord,
  InvitationRecord,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  SessionRecord,
  UpsertAuthGroupMembershipInput,
  UserIdentityRecord,
  UserRecord,
} from "../types"

export interface AuthStorageState {
  readonly users: Map<string, UserRecord>
  readonly identities: Map<string, UserIdentityRecord>
  readonly sessions: Map<string, SessionRecord>
  readonly invitations: Map<string, InvitationRecord>
  readonly groupMemberships: Map<string, GroupMembershipRecord>
  readonly magicLinks: Map<string, MagicLinkRecord>
  readonly oidcAuthorizationAttempts: Map<string, OidcAuthorizationAttemptRecord>
}

export function createAuthStorageState(): AuthStorageState {
  return {
    users: new Map(),
    identities: new Map(),
    sessions: new Map(),
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

export function sessionKey(projectId: string, id: string): string {
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
    throw new AuthStorageError("invalid_input", `[Sixb] ${label} must be a non-empty string.`)
  }
  return normalized
}

export function normalizeEmail(email: string): string {
  return assertNonEmpty(email, "Email").toLowerCase()
}

export function normalizeGroupIds(groupIds: readonly string[] | undefined): readonly string[] {
  return [...new Set((groupIds ?? []).map((groupId) => assertNonEmpty(groupId, "Group id")))]
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
  return !session.revokedAt && session.expiresAt > now
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
  audience?: string
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
    throw new AuthStorageError(
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
  const audience = assertNonEmpty(input.audience, "Session audience")
  const tokenHash = assertNonEmpty(input.tokenHash, "Session token hash")

  assertSessionIdAvailable(state, projectId, id)
  revokeActiveSessionsForUser(state, projectId, userId, input.createdAt, audience)

  const session: SessionRecord = {
    id,
    projectId,
    userId,
    strategyId,
    audience,
    tokenHash,
    createdAt: cloneDate(input.createdAt),
    expiresAt: cloneDate(input.expiresAt),
  }

  state.sessions.set(sessionKey(projectId, id), cloneRecord(session))
  return session
}

export function upsertGroupMembershipRecord(
  state: AuthStorageState,
  input: UpsertAuthGroupMembershipInput
): GroupMembershipRecord {
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const groupId = assertNonEmpty(input.groupId, "Group id")
  if (!state.users.has(userKey(projectId, userId))) {
    throw new AuthStorageError(
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
    throw new AuthStorageError(
      "missing_magic_link",
      `[Sixb] Magic link '${id}' not found for project '${projectId}'.`
    )
  }

  if (existing.tokenHash !== tokenHash || existing.consumedAt || existing.revokedAt) {
    throw new AuthStorageError(
      "invalid_magic_link",
      `[Sixb] Magic link '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (existing.expiresAt <= params.consumedAt) {
    throw new AuthStorageError(
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
    throw new AuthStorageError(
      "missing_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' not found for project '${projectId}'.`
    )
  }

  if (existing.stateHash !== stateHash || existing.consumedAt) {
    throw new AuthStorageError(
      "invalid_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (existing.expiresAt <= params.consumedAt) {
    throw new AuthStorageError(
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
