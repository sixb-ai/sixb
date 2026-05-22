import { AuthStorageError } from "../errors"
import type {
  AuthStorage,
  CompleteMagicLinkSignInInput,
  CompleteOidcSignInInput,
  CompleteSignInResult,
  GroupMembershipRecord,
  InvitationRecord,
  SessionRecord,
  SuspendUserAndRevokeSessionsInput,
  UserIdentityRecord,
  UserRecord,
} from "../types"
import { InMemoryAuthGroupMembershipStore } from "./group-memberships"
import { InMemoryAuthUserIdentityStore } from "./identities"
import { InMemoryAuthInvitationStore } from "./invitations"
import { InMemoryAuthMagicLinkStore } from "./magic-links"
import { InMemoryAuthOidcAuthorizationAttemptStore } from "./oidc-attempts"
import { InMemoryAuthSessionStore } from "./sessions"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneRecord,
  consumeMagicLinkRecord,
  consumeOidcAttemptRecord,
  createAuthStorageState,
  createSessionRecord,
  getActiveInvitationByEmail,
  getUserByEmail,
  identityKey,
  invitationKey,
  magicLinkKey,
  normalizeClaims,
  normalizeEmail,
  normalizeGroupIds,
  oidcAttemptKey,
  revokeActiveSessionsForUser,
  upsertGroupMembershipRecord,
  userKey,
  validateCompleteSessionInput,
} from "./shared"
import { InMemoryAuthUserStore } from "./users"

export class InMemoryAuthStorage implements AuthStorage {
  private readonly state: AuthStorageState = createAuthStorageState()

  readonly users = new InMemoryAuthUserStore(this.state)
  readonly identities = new InMemoryAuthUserIdentityStore(this.state)
  readonly sessions = new InMemoryAuthSessionStore(this.state)
  readonly invitations = new InMemoryAuthInvitationStore(this.state)
  readonly groupMemberships = new InMemoryAuthGroupMembershipStore(this.state)
  readonly magicLinks = new InMemoryAuthMagicLinkStore(this.state)
  readonly oidcAuthorizationAttempts = new InMemoryAuthOidcAuthorizationAttemptStore(this.state)

  async completeMagicLinkSignIn(
    input: CompleteMagicLinkSignInInput
  ): Promise<CompleteSignInResult> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const completedAt = cloneDate(input.completedAt)
    const magicLink = this.state.magicLinks.get(magicLinkKey(projectId, input.magicLinkId))

    if (!magicLink) {
      throw new AuthStorageError(
        "missing_magic_link",
        `[Pario] Magic link '${input.magicLinkId}' not found for project '${projectId}'.`
      )
    }

    if (magicLink.tokenHash !== input.tokenHash || magicLink.consumedAt || magicLink.revokedAt) {
      throw new AuthStorageError(
        "invalid_magic_link",
        `[Pario] Magic link '${input.magicLinkId}' is not valid for project '${projectId}'.`
      )
    }

    if (magicLink.expiresAt <= completedAt) {
      throw new AuthStorageError(
        "expired_magic_link",
        `[Pario] Magic link '${input.magicLinkId}' is expired for project '${projectId}'.`
      )
    }

    const existingUser = getUserByEmail(this.state, projectId, magicLink.email)
    const activeInvitation = getActiveInvitationByEmail(
      this.state,
      projectId,
      magicLink.email,
      completedAt
    )
    const shouldCreateUser = !existingUser
    const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

    if (existingUser?.status === "suspended") {
      consumeMagicLinkRecord(this.state, {
        projectId,
        id: input.magicLinkId,
        tokenHash: input.tokenHash,
        consumedAt: completedAt,
      })
      throw new AuthStorageError(
        "suspended_user",
        `[Pario] User '${existingUser.id}' is suspended for project '${projectId}'.`
      )
    }

    if (shouldCreateUser && !activeInvitation && !input.allowUserCreationWithoutInvitation) {
      consumeMagicLinkRecord(this.state, {
        projectId,
        id: input.magicLinkId,
        tokenHash: input.tokenHash,
        consumedAt: completedAt,
      })
      throw new AuthStorageError(
        "user_creation_not_allowed",
        `[Pario] Magic link '${input.magicLinkId}' cannot create a user for project '${projectId}'.`
      )
    }

    if (
      shouldCreateUser &&
      !activeInvitation &&
      input.allowUserCreationWithoutInvitation &&
      input.requireNoActiveUsersForUserCreation &&
      hasActiveUsers(this.state, projectId)
    ) {
      consumeMagicLinkRecord(this.state, {
        projectId,
        id: input.magicLinkId,
        tokenHash: input.tokenHash,
        consumedAt: completedAt,
      })
      throw new AuthStorageError(
        "user_creation_not_allowed",
        `[Pario] Magic link '${input.magicLinkId}' cannot create a user for project '${projectId}'.`
      )
    }

    validateCompleteSessionInput(this.state, projectId, input.session)

    let newUserId: string | undefined
    if (shouldCreateUser) {
      newUserId = assertNonEmpty(input.newUserId, "User id")
      if (this.state.users.has(userKey(projectId, newUserId))) {
        throw new AuthStorageError(
          "duplicate_user",
          `[Pario] User '${newUserId}' already exists for project '${projectId}'.`
        )
      }
    }

    consumeMagicLinkRecord(this.state, {
      projectId,
      id: input.magicLinkId,
      tokenHash: input.tokenHash,
      consumedAt: completedAt,
    })

    let user = existingUser
    if (!user) {
      user = {
        id: newUserId ?? assertNonEmpty(input.newUserId, "User id"),
        projectId,
        email: magicLink.email,
        displayName: input.newUserDisplayName,
        avatarUrl: input.newUserAvatarUrl,
        status: "active",
        createdAt: completedAt,
        updatedAt: completedAt,
      }
      this.state.users.set(userKey(projectId, user.id), cloneRecord(user))
    }

    const invitation = this.acceptInvitationAndApplyGroups({
      activeInvitation,
      completedAt,
      projectId,
      user,
    })
    const memberships = this.applyManualGroups({
      completedAt,
      groupIds: manualGroupIds,
      projectId,
      userId: user.id,
      existing: invitation.memberships,
    })

    const session = this.createSignInSession({
      projectId,
      strategyId: magicLink.strategyId,
      session: input.session,
      userId: user.id,
    })

    return {
      user: cloneRecord(user),
      session: cloneRecord(session),
      invitation: invitation.invitation ? cloneRecord(invitation.invitation) : undefined,
      groupMemberships: memberships.map(cloneRecord),
    }
  }

  async completeOidcSignIn(input: CompleteOidcSignInInput): Promise<CompleteSignInResult> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const completedAt = cloneDate(input.completedAt)
    const attempt = this.state.oidcAuthorizationAttempts.get(
      oidcAttemptKey(projectId, input.oidcAuthorizationAttemptId)
    )

    if (!attempt) {
      throw new AuthStorageError(
        "missing_oidc_attempt",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' not found for project '${projectId}'.`
      )
    }

    if (attempt.stateHash !== input.stateHash || attempt.consumedAt) {
      throw new AuthStorageError(
        "invalid_oidc_attempt",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' is not valid for project '${projectId}'.`
      )
    }

    if (attempt.expiresAt <= completedAt) {
      throw new AuthStorageError(
        "expired_oidc_attempt",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' is expired for project '${projectId}'.`
      )
    }

    const subject = assertNonEmpty(input.subject, "Subject")
    const email = normalizeEmail(input.email)
    const claims = normalizeClaims(input.claims)
    const identity = this.state.identities.get(identityKey(projectId, attempt.strategyId, subject))
    const activeInvitation = identity
      ? null
      : getActiveInvitationByEmail(this.state, projectId, email, completedAt)
    let user = identity
      ? (this.state.users.get(userKey(projectId, identity.userId)) ?? null)
      : getUserByEmail(this.state, projectId, email)
    const shouldCreateUser = !identity && !user
    const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

    if (identity && !user) {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "missing_user",
        `[Pario] User '${identity.userId}' not found for linked OIDC identity.`
      )
    }

    if (!identity && user && (!input.autoLinkByVerifiedEmail || !input.emailVerified)) {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "email_link_not_allowed",
        `[Pario] OIDC identity cannot auto-link to user '${user.id}' for project '${projectId}'.`
      )
    }

    if (user?.status === "suspended") {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "suspended_user",
        `[Pario] User '${user.id}' is suspended for project '${projectId}'.`
      )
    }

    if (shouldCreateUser && !input.emailVerified) {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "user_creation_not_allowed",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
      )
    }

    if (shouldCreateUser && !activeInvitation && !input.allowUserCreationWithoutInvitation) {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "user_creation_not_allowed",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
      )
    }

    if (
      shouldCreateUser &&
      !activeInvitation &&
      input.allowUserCreationWithoutInvitation &&
      input.requireNoActiveUsersForUserCreation &&
      hasActiveUsers(this.state, projectId)
    ) {
      this.consumeOidcAttempt(input, completedAt, projectId)
      throw new AuthStorageError(
        "user_creation_not_allowed",
        `[Pario] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
      )
    }

    validateCompleteSessionInput(this.state, projectId, input.session)

    let newUserId: string | undefined
    if (shouldCreateUser) {
      newUserId = assertNonEmpty(input.newUserId, "User id")
      if (this.state.users.has(userKey(projectId, newUserId))) {
        throw new AuthStorageError(
          "duplicate_user",
          `[Pario] User '${newUserId}' already exists for project '${projectId}'.`
        )
      }
    }

    this.consumeOidcAttempt(input, completedAt, projectId)

    if (!user) {
      user = {
        id: newUserId ?? assertNonEmpty(input.newUserId, "User id"),
        projectId,
        email,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        status: "active",
        createdAt: completedAt,
        updatedAt: completedAt,
      }
      this.state.users.set(userKey(projectId, user.id), cloneRecord(user))
    }

    const invitation = this.acceptInvitationAndApplyGroups({
      activeInvitation,
      completedAt,
      projectId,
      user,
    })
    const memberships = this.applyManualGroups({
      completedAt,
      groupIds: manualGroupIds,
      projectId,
      userId: user.id,
      existing: invitation.memberships,
    })

    const nextIdentity: UserIdentityRecord = {
      projectId,
      strategyId: attempt.strategyId,
      subject,
      userId: user.id,
      claims,
      createdAt: identity?.createdAt ?? completedAt,
      updatedAt: completedAt,
    }
    this.state.identities.set(
      identityKey(projectId, attempt.strategyId, subject),
      cloneRecord(nextIdentity)
    )

    const session = this.createSignInSession({
      projectId,
      strategyId: attempt.strategyId,
      session: input.session,
      userId: user.id,
    })

    return {
      user: cloneRecord(user),
      session: cloneRecord(session),
      identity: cloneRecord(nextIdentity),
      invitation: invitation.invitation ? cloneRecord(invitation.invitation) : undefined,
      groupMemberships: memberships.map(cloneRecord),
    }
  }

  async suspendUserAndRevokeSessions(
    input: SuspendUserAndRevokeSessionsInput
  ): Promise<UserRecord> {
    const key = userKey(input.projectId, input.userId)
    const existing = this.state.users.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_user",
        `[Pario] User '${input.userId}' not found for project '${input.projectId}'.`
      )
    }

    const next: UserRecord = {
      ...existing,
      status: "suspended",
      updatedAt: cloneDate(input.suspendedAt),
    }
    this.state.users.set(key, cloneRecord(next))
    revokeActiveSessionsForUser(this.state, input.projectId, input.userId, input.suspendedAt)

    return cloneRecord(next)
  }

  private acceptInvitationAndApplyGroups(input: {
    readonly activeInvitation: InvitationRecord | null
    readonly completedAt: Date
    readonly projectId: string
    readonly user: UserRecord
  }): {
    readonly invitation?: InvitationRecord
    readonly memberships: readonly GroupMembershipRecord[]
  } {
    if (!input.activeInvitation) {
      return { memberships: [] }
    }

    const invitation: InvitationRecord = {
      ...input.activeInvitation,
      status: "accepted",
      acceptedAt: input.completedAt,
      updatedAt: input.completedAt,
    }
    this.state.invitations.set(
      invitationKey(input.projectId, invitation.id),
      cloneRecord(invitation)
    )

    const memberships = input.activeInvitation.groupIds.map((groupId) =>
      upsertGroupMembershipRecord(this.state, {
        projectId: input.projectId,
        userId: input.user.id,
        groupId,
        source: "invitation",
        createdAt: input.completedAt,
      })
    )

    return { invitation, memberships }
  }

  private applyManualGroups(input: {
    readonly completedAt: Date
    readonly groupIds: readonly string[]
    readonly projectId: string
    readonly userId: string
    readonly existing: readonly GroupMembershipRecord[]
  }): readonly GroupMembershipRecord[] {
    const memberships = [...input.existing]
    for (const groupId of input.groupIds) {
      memberships.push(
        upsertGroupMembershipRecord(this.state, {
          projectId: input.projectId,
          userId: input.userId,
          groupId,
          source: "manual",
          createdAt: input.completedAt,
        })
      )
    }
    return memberships
  }

  private createSignInSession(input: {
    readonly projectId: string
    readonly strategyId: string
    readonly session: CompleteMagicLinkSignInInput["session"]
    readonly userId: string
  }): SessionRecord {
    return createSessionRecord(this.state, {
      id: input.session.id,
      projectId: input.projectId,
      userId: input.userId,
      strategyId: input.strategyId,
      tokenHash: input.session.tokenHash,
      createdAt: input.session.createdAt,
      expiresAt: input.session.expiresAt,
    })
  }

  private consumeOidcAttempt(
    input: CompleteOidcSignInInput,
    completedAt: Date,
    projectId: string
  ): void {
    consumeOidcAttemptRecord(this.state, {
      projectId,
      id: input.oidcAuthorizationAttemptId,
      stateHash: input.stateHash,
      consumedAt: completedAt,
    })
  }
}

function hasActiveUsers(state: AuthStorageState, projectId: string): boolean {
  for (const user of state.users.values()) {
    if (user.projectId === projectId && user.status === "active") {
      return true
    }
  }

  return false
}
