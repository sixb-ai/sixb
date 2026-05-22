import type { AuthSessionAudience, Principal } from "../../auth"

export type UserStatus = "active" | "suspended"
export type InvitationStatus = "pending" | "accepted" | "revoked"
export type GroupMembershipSource = "invitation" | "manual"

export interface UserRecord {
  readonly id: string
  readonly projectId: string
  readonly email: string
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly status: UserStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface UserIdentityRecord {
  readonly projectId: string
  readonly strategyId: string
  readonly subject: string
  readonly userId: string
  readonly claims?: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface SessionRecord {
  readonly id: string
  readonly projectId: string
  readonly userId: string
  readonly strategyId: string
  readonly audience: AuthSessionAudience
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
  readonly lastSeenAt?: Date
}

export interface InvitationRecord {
  readonly id: string
  readonly projectId: string
  readonly email: string
  readonly groupIds: readonly string[]
  readonly status: InvitationStatus
  readonly createdByPrincipal?: Principal
  readonly createdBySessionId?: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date
  readonly acceptedAt?: Date
  readonly revokedAt?: Date
}

export interface GroupMembershipRecord {
  readonly projectId: string
  readonly userId: string
  readonly groupId: string
  readonly source: GroupMembershipSource
  readonly createdAt: Date
}

export interface MagicLinkRecord {
  readonly id: string
  readonly projectId: string
  readonly strategyId: string
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date
  readonly revokedAt?: Date
}

export interface OidcAuthorizationAttemptRecord {
  readonly id: string
  readonly projectId: string
  readonly strategyId: string
  readonly stateHash: string
  readonly nonceHash: string
  readonly codeVerifier: string
  readonly returnTo?: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date
}

export interface CreateAuthUserInput {
  readonly id: string
  readonly projectId: string
  readonly email: string
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly status?: UserStatus
  readonly createdAt?: Date
  readonly updatedAt?: Date
}

export interface UpdateAuthUserProfileInput {
  readonly projectId: string
  readonly id: string
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly updatedAt?: Date
}

export interface UpdateAuthUserStatusInput {
  readonly projectId: string
  readonly id: string
  readonly status: UserStatus
  readonly updatedAt?: Date
}

export interface ListAuthUsersInput {
  readonly projectId: string
  readonly statuses?: readonly UserStatus[]
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAuthUsersResult {
  readonly users: readonly UserRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface UpsertAuthUserIdentityInput {
  readonly projectId: string
  readonly strategyId: string
  readonly subject: string
  readonly userId: string
  readonly claims?: Readonly<Record<string, unknown>>
  readonly createdAt?: Date
  readonly updatedAt?: Date
}

export interface CreateAuthSessionInput {
  readonly id: string
  readonly projectId: string
  readonly userId: string
  readonly strategyId: string
  readonly audience: AuthSessionAudience
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface CompleteAuthSessionInput {
  readonly id: string
  readonly audience: AuthSessionAudience
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface CreateOrUpdateAuthInvitationInput {
  readonly id: string
  readonly projectId: string
  readonly email: string
  readonly groupIds?: readonly string[]
  readonly createdByPrincipal?: Principal
  readonly createdBySessionId?: string
  readonly createdAt?: Date
  readonly updatedAt?: Date
  readonly expiresAt: Date
}

export interface ListAuthInvitationsInput {
  readonly projectId: string
  readonly email?: string
  readonly statuses?: readonly InvitationStatus[]
  readonly groupIds?: readonly string[]
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAuthInvitationsResult {
  readonly invitations: readonly InvitationRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface UpsertAuthGroupMembershipInput {
  readonly projectId: string
  readonly userId: string
  readonly groupId: string
  readonly source: GroupMembershipSource
  readonly createdAt?: Date
}

export interface CreateAuthMagicLinkInput {
  readonly id: string
  readonly projectId: string
  readonly strategyId: string
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface CreateOidcAuthorizationAttemptInput {
  readonly id: string
  readonly projectId: string
  readonly strategyId: string
  readonly stateHash: string
  readonly nonceHash: string
  readonly codeVerifier: string
  readonly returnTo?: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface CompleteMagicLinkSignInInput {
  readonly projectId: string
  readonly magicLinkId: string
  readonly tokenHash: string
  readonly completedAt: Date
  readonly newUserId: string
  readonly newUserDisplayName?: string
  readonly newUserAvatarUrl?: string
  readonly allowUserCreationWithoutInvitation?: boolean
  readonly requireNoActiveUsersForUserCreation?: boolean
  readonly manualGroupIds?: readonly string[]
  readonly session: CompleteAuthSessionInput
}

export interface CompleteOidcSignInInput {
  readonly projectId: string
  readonly oidcAuthorizationAttemptId: string
  readonly stateHash: string
  readonly completedAt: Date
  readonly subject: string
  readonly email: string
  readonly emailVerified?: boolean
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly claims?: Readonly<Record<string, unknown>>
  readonly autoLinkByVerifiedEmail?: boolean
  readonly allowUserCreationWithoutInvitation?: boolean
  readonly requireNoActiveUsersForUserCreation?: boolean
  readonly manualGroupIds?: readonly string[]
  readonly newUserId: string
  readonly session: CompleteAuthSessionInput
}

export interface CompleteSignInResult {
  readonly user: UserRecord
  readonly session: SessionRecord
  readonly identity?: UserIdentityRecord
  readonly invitation?: InvitationRecord
  readonly groupMemberships: readonly GroupMembershipRecord[]
}

export interface SuspendUserAndRevokeSessionsInput {
  readonly projectId: string
  readonly userId: string
  readonly suspendedAt: Date
}

export interface AuthUserStore {
  create(input: CreateAuthUserInput): Promise<UserRecord>
  getById(params: { readonly projectId: string; readonly id: string }): Promise<UserRecord | null>
  getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null>
  updateProfile(input: UpdateAuthUserProfileInput): Promise<UserRecord>
  updateStatus(input: UpdateAuthUserStatusInput): Promise<UserRecord>
  list(input: ListAuthUsersInput): Promise<ListAuthUsersResult>
}

export interface AuthUserIdentityStore {
  upsert(input: UpsertAuthUserIdentityInput): Promise<UserIdentityRecord>
  getBySubject(params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  }): Promise<UserIdentityRecord | null>
  listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly UserIdentityRecord[]>
}

export interface AuthSessionStore {
  create(input: CreateAuthSessionInput): Promise<SessionRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<SessionRecord | null>
  getActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience: AuthSessionAudience
    readonly now: Date
  }): Promise<SessionRecord | null>
  findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly audience: AuthSessionAudience
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null>
  revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<SessionRecord>
  revokeActiveForUser(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: AuthSessionAudience
    readonly revokedAt: Date
  }): Promise<readonly SessionRecord[]>
  touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastSeenAt: Date
  }): Promise<SessionRecord>
}

export interface AuthInvitationStore {
  createOrUpdateActive(input: CreateOrUpdateAuthInvitationInput): Promise<InvitationRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<InvitationRecord | null>
  getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<InvitationRecord | null>
  list(input: ListAuthInvitationsInput): Promise<ListAuthInvitationsResult>
  accept(params: {
    readonly projectId: string
    readonly id: string
    readonly acceptedAt: Date
  }): Promise<InvitationRecord>
  revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<InvitationRecord>
}

export interface AuthGroupMembershipStore {
  upsert(input: UpsertAuthGroupMembershipInput): Promise<GroupMembershipRecord>
  listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly GroupMembershipRecord[]>
  listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly GroupMembershipRecord[]>
}

export interface AuthMagicLinkStore {
  create(input: CreateAuthMagicLinkInput): Promise<MagicLinkRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<MagicLinkRecord | null>
  getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<MagicLinkRecord | null>
  consume(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }): Promise<MagicLinkRecord>
  revokeActiveForEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly revokedAt: Date
  }): Promise<readonly MagicLinkRecord[]>
}

export interface AuthOidcAuthorizationAttemptStore {
  create(input: CreateOidcAuthorizationAttemptInput): Promise<OidcAuthorizationAttemptRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<OidcAuthorizationAttemptRecord | null>
  consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<OidcAuthorizationAttemptRecord>
}

export interface AuthStorage {
  readonly users: AuthUserStore
  readonly identities: AuthUserIdentityStore
  readonly sessions: AuthSessionStore
  readonly invitations: AuthInvitationStore
  readonly groupMemberships: AuthGroupMembershipStore
  readonly magicLinks: AuthMagicLinkStore
  readonly oidcAuthorizationAttempts: AuthOidcAuthorizationAttemptStore

  completeMagicLinkSignIn(input: CompleteMagicLinkSignInInput): Promise<CompleteSignInResult>
  completeOidcSignIn(input: CompleteOidcSignInInput): Promise<CompleteSignInResult>
  suspendUserAndRevokeSessions(input: SuspendUserAndRevokeSessionsInput): Promise<UserRecord>
}
