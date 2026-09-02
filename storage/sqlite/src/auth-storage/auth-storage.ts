import type { Database } from "bun:sqlite"
import type {
  AuthStorage,
  CompleteDeviceAuthorizationInput,
  CompleteDeviceAuthorizationResult,
  CompleteMagicLinkSignInInput,
  CompleteOidcSignInInput,
  CompleteSignInResult,
  DeviceAuthorizationRecord,
  GroupMembershipRecord,
  InvitationRecord,
  SessionRecord,
  SuspendUserAndRevokeSessionsInput,
  UserIdentityRecord,
  UserRecord,
} from "@sixb/core/storage"
import { AuthStorageError } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "../migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "../transactions"
import { createAuthAccessToken, SqliteAuthAccessTokenStore } from "./access-tokens"
import {
  getDeviceAuthorizationById,
  SqliteAuthDeviceAuthorizationStore,
} from "./device-authorizations"
import { SqliteAuthGroupMembershipStore } from "./group-memberships"
import { SqliteAuthUserIdentityStore } from "./identities"
import { SqliteAuthInvitationStore } from "./invitations"
import { SqliteAuthMagicLinkStore } from "./magic-links"
import { SqliteAuthOidcAuthorizationAttemptStore } from "./oidc-attempts"
import type { SqliteAuthMagicLinkRow, SqliteAuthOidcAttemptRow } from "./rows"
import { rowToIdentityRecord, rowToUserRecord, serializeOptionalRecord } from "./rows"
import { SqliteAuthServiceAccountGroupMembershipStore } from "./service-account-group-memberships"
import { SqliteAuthServiceAccountStore } from "./service-accounts"
import { SqliteAuthSessionStore } from "./sessions"
import {
  assertNonEmpty,
  consumeMagicLink,
  consumeOidcAttempt,
  createSession,
  getActiveInvitationByEmail,
  getIdentityRowBySubject,
  getMagicLinkRowById,
  getOidcAttemptRowById,
  getUserRowByEmail,
  getUserRowById,
  mapUniqueConstraintError,
  normalizeEmail,
  normalizeGroupIds,
  revokeActiveSessionsForUser,
  toIso,
  upsertGroupMembership,
  validateCompleteSessionInput,
} from "./shared"
import { SqliteAuthUserStore } from "./users"

interface AuthTransactionError {
  readonly error: AuthStorageError
}

export interface SqliteAuthStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteAuthStorage implements AuthStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  readonly users: SqliteAuthUserStore
  readonly identities: SqliteAuthUserIdentityStore
  readonly serviceAccounts: SqliteAuthServiceAccountStore
  readonly serviceAccountGroupMemberships: SqliteAuthServiceAccountGroupMembershipStore
  readonly sessions: SqliteAuthSessionStore
  readonly accessTokens: SqliteAuthAccessTokenStore
  readonly invitations: SqliteAuthInvitationStore
  readonly groupMemberships: SqliteAuthGroupMembershipStore
  readonly magicLinks: SqliteAuthMagicLinkStore
  readonly oidcAuthorizationAttempts: SqliteAuthOidcAuthorizationAttemptStore
  readonly deviceAuthorizations: SqliteAuthDeviceAuthorizationStore

  constructor(options: SqliteAuthStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }

    this.users = new SqliteAuthUserStore(this.db)
    this.identities = new SqliteAuthUserIdentityStore(this.db)
    this.serviceAccounts = new SqliteAuthServiceAccountStore(this.db)
    this.serviceAccountGroupMemberships = new SqliteAuthServiceAccountGroupMembershipStore(this.db)
    this.sessions = new SqliteAuthSessionStore(this.db)
    this.accessTokens = new SqliteAuthAccessTokenStore(this.db)
    this.invitations = new SqliteAuthInvitationStore(this.db)
    this.groupMemberships = new SqliteAuthGroupMembershipStore(this.db)
    this.magicLinks = new SqliteAuthMagicLinkStore(this.db)
    this.oidcAuthorizationAttempts = new SqliteAuthOidcAuthorizationAttemptStore(this.db)
    this.deviceAuthorizations = new SqliteAuthDeviceAuthorizationStore(this.db)
  }

  async completeDeviceAuthorization(
    input: CompleteDeviceAuthorizationInput
  ): Promise<CompleteDeviceAuthorizationResult> {
    return runImmediateTransaction(this.db, () => {
      const authorization = getDeviceAuthorizationById(this.db, input.projectId, input.id)
      if (!authorization) {
        throw new AuthStorageError(
          "missing_device_authorization",
          `[Sixb] Device authorization '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      assertCompletableDeviceAuthorization(authorization, input)
      const accessToken = createAuthAccessToken(this.db, input.accessToken)
      this.db
        .query(`
        UPDATE auth_device_authorizations
        SET status = 'consumed', consumed_at = ?
        WHERE project_id = ? AND id = ? AND status = 'approved'
      `)
        .run(toIso(input.completedAt), input.projectId, input.id)
      return {
        authorization: {
          ...authorization,
          status: "consumed",
          consumedAt: new Date(input.completedAt),
        },
        accessToken,
      }
    })
  }

  async completeMagicLinkSignIn(
    input: CompleteMagicLinkSignInInput
  ): Promise<CompleteSignInResult> {
    const result = runImmediateTransaction(
      this.db,
      (): CompleteSignInResult | AuthTransactionError => {
        const projectId = assertNonEmpty(input.projectId, "Project id")
        const completedAt = new Date(input.completedAt)
        const magicLink = getMagicLinkRowById(this.db, {
          projectId,
          id: input.magicLinkId,
        })

        this.assertMagicLinkUsable(
          projectId,
          input.magicLinkId,
          input.tokenHash,
          completedAt,
          magicLink
        )

        const existingUserRow = getUserRowByEmail(this.db, {
          projectId,
          email: magicLink.email,
        })
        const activeInvitation = getActiveInvitationByEmail(this.db, {
          projectId,
          email: magicLink.email,
          now: completedAt,
        })
        const shouldCreateUser = !existingUserRow
        const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

        if (existingUserRow?.status === "suspended") {
          consumeMagicLink(this.db, {
            projectId,
            id: input.magicLinkId,
            tokenHash: input.tokenHash,
            consumedAt: completedAt,
          })
          return {
            error: new AuthStorageError(
              "suspended_user",
              `[Sixb] User '${existingUserRow.id}' is suspended for project '${projectId}'.`
            ),
          }
        }

        if (shouldCreateUser && !activeInvitation && !input.allowUserCreationWithoutInvitation) {
          consumeMagicLink(this.db, {
            projectId,
            id: input.magicLinkId,
            tokenHash: input.tokenHash,
            consumedAt: completedAt,
          })
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] Magic link '${input.magicLinkId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        if (
          shouldCreateUser &&
          !activeInvitation &&
          input.allowUserCreationWithoutInvitation &&
          input.requireNoActiveUsersForUserCreation &&
          hasActiveUsers(this.db, projectId)
        ) {
          consumeMagicLink(this.db, {
            projectId,
            id: input.magicLinkId,
            tokenHash: input.tokenHash,
            consumedAt: completedAt,
          })
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] Magic link '${input.magicLinkId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        validateCompleteSessionInput(this.db, projectId, input.session)
        assertSignInSessionAudience(projectId, input.session.audience, magicLink.audience)

        let newUserId: string | undefined
        if (shouldCreateUser) {
          newUserId = assertNonEmpty(input.newUserId, "User id")
          if (getUserRowById(this.db, { projectId, id: newUserId })) {
            throw new AuthStorageError(
              "duplicate_user",
              `[Sixb] User '${newUserId}' already exists for project '${projectId}'.`
            )
          }
        }

        consumeMagicLink(this.db, {
          projectId,
          id: input.magicLinkId,
          tokenHash: input.tokenHash,
          consumedAt: completedAt,
        })

        const user = existingUserRow
          ? rowToUserRecord(existingUserRow)
          : this.insertUser({
              id: newUserId ?? assertNonEmpty(input.newUserId, "User id"),
              projectId,
              email: magicLink.email,
              displayName: input.newUserDisplayName,
              avatarUrl: input.newUserAvatarUrl,
              createdAt: completedAt,
            })

        const invitation = this.acceptInvitationAndApplyGroups({
          activeInvitation,
          completedAt,
          projectId,
          user,
        })
        const groupMemberships = this.applyManualGroups({
          completedAt,
          existing: invitation.groupMemberships,
          groupIds: manualGroupIds,
          projectId,
          userId: user.id,
        })
        const session = this.createSignInSession({
          projectId,
          strategyId: magicLink.strategy_id,
          session: input.session,
          userId: user.id,
        })

        return {
          user,
          session,
          invitation: invitation.invitation,
          groupMemberships,
        }
      }
    )

    if ("error" in result) {
      throw result.error
    }

    return result
  }

  async completeOidcSignIn(input: CompleteOidcSignInInput): Promise<CompleteSignInResult> {
    const result = runImmediateTransaction(
      this.db,
      (): CompleteSignInResult | AuthTransactionError => {
        const projectId = assertNonEmpty(input.projectId, "Project id")
        const completedAt = new Date(input.completedAt)
        const attempt = getOidcAttemptRowById(this.db, {
          projectId,
          id: input.oidcAuthorizationAttemptId,
        })

        this.assertOidcAttemptUsable(
          projectId,
          input.oidcAuthorizationAttemptId,
          input.stateHash,
          completedAt,
          attempt
        )

        const subject = assertNonEmpty(input.subject, "Subject")
        const email = normalizeEmail(input.email)
        const identity = getIdentityRowBySubject(this.db, {
          projectId,
          strategyId: attempt.strategy_id,
          subject,
        })
        const activeInvitation = identity
          ? null
          : getActiveInvitationByEmail(this.db, {
              projectId,
              email,
              now: completedAt,
            })
        let userRow = identity
          ? getUserRowById(this.db, { projectId, id: identity.user_id })
          : getUserRowByEmail(this.db, { projectId, email })
        const shouldCreateUser = !identity && !userRow
        const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

        if (identity && !userRow) {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "missing_user",
              `[Sixb] User '${identity.user_id}' not found for linked OIDC identity.`
            ),
          }
        }

        if (!identity && userRow && (!input.autoLinkByVerifiedEmail || !input.emailVerified)) {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "email_link_not_allowed",
              `[Sixb] OIDC identity cannot auto-link to user '${userRow.id}' for project '${projectId}'.`
            ),
          }
        }

        if (userRow?.status === "suspended") {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "suspended_user",
              `[Sixb] User '${userRow.id}' is suspended for project '${projectId}'.`
            ),
          }
        }

        if (shouldCreateUser && !input.emailVerified) {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        if (shouldCreateUser && !activeInvitation && !input.allowUserCreationWithoutInvitation) {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        if (
          shouldCreateUser &&
          !activeInvitation &&
          input.allowUserCreationWithoutInvitation &&
          input.requireNoActiveUsersForUserCreation &&
          hasActiveUsers(this.db, projectId)
        ) {
          this.consumeOidcAttempt(input, completedAt, projectId)
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        validateCompleteSessionInput(this.db, projectId, input.session)
        assertSignInSessionAudience(projectId, input.session.audience, attempt.audience)

        let newUserId: string | undefined
        if (shouldCreateUser) {
          newUserId = assertNonEmpty(input.newUserId, "User id")
          if (getUserRowById(this.db, { projectId, id: newUserId })) {
            throw new AuthStorageError(
              "duplicate_user",
              `[Sixb] User '${newUserId}' already exists for project '${projectId}'.`
            )
          }
        }

        this.consumeOidcAttempt(input, completedAt, projectId)

        if (!userRow) {
          const user = this.insertUser({
            id: newUserId ?? assertNonEmpty(input.newUserId, "User id"),
            projectId,
            email,
            displayName: input.displayName,
            avatarUrl: input.avatarUrl,
            createdAt: completedAt,
          })
          userRow = {
            project_id: user.projectId,
            id: user.id,
            email: user.email,
            display_name: user.displayName ?? null,
            avatar_url: user.avatarUrl ?? null,
            status: user.status,
            created_at: toIso(user.createdAt),
            updated_at: toIso(user.updatedAt),
          }
        }

        const user = rowToUserRecord(userRow)
        const invitation = this.acceptInvitationAndApplyGroups({
          activeInvitation,
          completedAt,
          projectId,
          user,
        })
        const groupMemberships = this.applyManualGroups({
          completedAt,
          existing: invitation.groupMemberships,
          groupIds: manualGroupIds,
          projectId,
          userId: user.id,
        })
        const nextIdentity = this.upsertIdentity({
          projectId,
          strategyId: attempt.strategy_id,
          subject,
          userId: user.id,
          claims: input.claims,
          createdAt: identity ? new Date(identity.created_at) : completedAt,
          updatedAt: completedAt,
        })
        const session = this.createSignInSession({
          projectId,
          strategyId: attempt.strategy_id,
          session: input.session,
          userId: user.id,
        })

        return {
          user,
          session,
          identity: nextIdentity,
          invitation: invitation.invitation,
          groupMemberships,
        }
      }
    )

    if ("error" in result) {
      throw result.error
    }

    return result
  }

  async suspendUserAndRevokeSessions(
    input: SuspendUserAndRevokeSessionsInput
  ): Promise<UserRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = getUserRowById(this.db, {
        projectId: input.projectId,
        id: input.userId,
      })

      if (!existing) {
        throw new AuthStorageError(
          "missing_user",
          `[Sixb] User '${input.userId}' not found for project '${input.projectId}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE auth_users
          SET status = 'suspended',
              updated_at = ?
          WHERE project_id = ?
            AND id = ?
        `
        )
        .run(toIso(input.suspendedAt), input.projectId, input.userId)
      revokeActiveSessionsForUser(this.db, {
        projectId: input.projectId,
        userId: input.userId,
        revokedAt: input.suspendedAt,
      })

      return rowToUserRecord({
        ...existing,
        status: "suspended",
        updated_at: toIso(input.suspendedAt),
      })
    })
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private assertMagicLinkUsable(
    projectId: string,
    id: string,
    tokenHash: string,
    completedAt: Date,
    row: SqliteAuthMagicLinkRow | null
  ): asserts row is SqliteAuthMagicLinkRow {
    if (!row) {
      throw new AuthStorageError(
        "missing_magic_link",
        `[Sixb] Magic link '${id}' not found for project '${projectId}'.`
      )
    }

    if (row.token_hash !== tokenHash || row.consumed_at || row.revoked_at) {
      throw new AuthStorageError(
        "invalid_magic_link",
        `[Sixb] Magic link '${id}' is not valid for project '${projectId}'.`
      )
    }

    if (new Date(row.expires_at) <= completedAt) {
      throw new AuthStorageError(
        "expired_magic_link",
        `[Sixb] Magic link '${id}' is expired for project '${projectId}'.`
      )
    }
  }

  private assertOidcAttemptUsable(
    projectId: string,
    id: string,
    stateHash: string,
    completedAt: Date,
    row: SqliteAuthOidcAttemptRow | null
  ): asserts row is SqliteAuthOidcAttemptRow {
    if (!row) {
      throw new AuthStorageError(
        "missing_oidc_attempt",
        `[Sixb] OIDC authorization attempt '${id}' not found for project '${projectId}'.`
      )
    }

    if (row.state_hash !== stateHash || row.consumed_at) {
      throw new AuthStorageError(
        "invalid_oidc_attempt",
        `[Sixb] OIDC authorization attempt '${id}' is not valid for project '${projectId}'.`
      )
    }

    if (new Date(row.expires_at) <= completedAt) {
      throw new AuthStorageError(
        "expired_oidc_attempt",
        `[Sixb] OIDC authorization attempt '${id}' is expired for project '${projectId}'.`
      )
    }
  }

  private insertUser(input: {
    readonly id: string
    readonly projectId: string
    readonly email: string
    readonly displayName?: string
    readonly avatarUrl?: string
    readonly createdAt: Date
  }): UserRecord {
    try {
      this.db
        .query(
          `
          INSERT INTO auth_users (
            project_id,
            id,
            email,
            display_name,
            avatar_url,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.email,
          input.displayName ?? null,
          input.avatarUrl ?? null,
          toIso(input.createdAt),
          toIso(input.createdAt)
        )
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_user",
        `[Sixb] User '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    return {
      id: input.id,
      projectId: input.projectId,
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: "active",
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    }
  }

  private acceptInvitationAndApplyGroups(input: {
    readonly activeInvitation: InvitationRecord | null
    readonly completedAt: Date
    readonly projectId: string
    readonly user: UserRecord
  }): {
    readonly invitation?: InvitationRecord
    readonly groupMemberships: readonly GroupMembershipRecord[]
  } {
    if (!input.activeInvitation) {
      return { groupMemberships: [] }
    }

    this.db
      .query(
        `
        UPDATE auth_invitations
        SET status = 'accepted',
            accepted_at = ?,
            updated_at = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(
        toIso(input.completedAt),
        toIso(input.completedAt),
        input.projectId,
        input.activeInvitation.id
      )

    const invitation: InvitationRecord = {
      ...input.activeInvitation,
      status: "accepted",
      acceptedAt: new Date(input.completedAt),
      updatedAt: new Date(input.completedAt),
    }
    const groupMemberships = input.activeInvitation.groupIds.map((groupId) =>
      upsertGroupMembership(this.db, {
        projectId: input.projectId,
        userId: input.user.id,
        groupId,
        source: "invitation",
        createdAt: input.completedAt,
      })
    )

    return { invitation, groupMemberships }
  }

  private applyManualGroups(input: {
    readonly completedAt: Date
    readonly existing: readonly GroupMembershipRecord[]
    readonly groupIds: readonly string[]
    readonly projectId: string
    readonly userId: string
  }): readonly GroupMembershipRecord[] {
    const groupMemberships = [...input.existing]

    for (const groupId of input.groupIds) {
      groupMemberships.push(
        upsertGroupMembership(this.db, {
          projectId: input.projectId,
          userId: input.userId,
          groupId,
          source: "manual",
          createdAt: input.completedAt,
        })
      )
    }

    return groupMemberships
  }

  private createSignInSession(input: {
    readonly projectId: string
    readonly strategyId: string
    readonly session: CompleteMagicLinkSignInInput["session"]
    readonly userId: string
  }): SessionRecord {
    return createSession(this.db, {
      id: input.session.id,
      projectId: input.projectId,
      userId: input.userId,
      strategyId: input.strategyId,
      audience: input.session.audience,
      tokenHash: input.session.tokenHash,
      createdAt: input.session.createdAt,
      expiresAt: input.session.expiresAt,
      absoluteExpiresAt: input.session.absoluteExpiresAt,
      userAgent: input.session.userAgent,
      ipAddress: input.session.ipAddress,
    })
  }

  private consumeOidcAttempt(
    input: CompleteOidcSignInInput,
    completedAt: Date,
    projectId: string
  ): void {
    consumeOidcAttempt(this.db, {
      projectId,
      id: input.oidcAuthorizationAttemptId,
      stateHash: input.stateHash,
      consumedAt: completedAt,
    })
  }

  private upsertIdentity(input: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
    readonly userId: string
    readonly claims?: Readonly<Record<string, unknown>>
    readonly createdAt: Date
    readonly updatedAt: Date
  }): UserIdentityRecord {
    this.db
      .query(
        `
        INSERT INTO auth_user_identities (
          project_id,
          strategy_id,
          subject,
          user_id,
          claims,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, strategy_id, subject)
        DO UPDATE SET
          user_id = excluded.user_id,
          claims = excluded.claims,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.projectId,
        input.strategyId,
        input.subject,
        input.userId,
        serializeOptionalRecord(input.claims),
        toIso(input.createdAt),
        toIso(input.updatedAt)
      )

    return rowToIdentityRecord({
      project_id: input.projectId,
      strategy_id: input.strategyId,
      subject: input.subject,
      user_id: input.userId,
      claims: serializeOptionalRecord(input.claims),
      created_at: toIso(input.createdAt),
      updated_at: toIso(input.updatedAt),
    })
  }
}

function hasActiveUsers(db: Database, projectId: string): boolean {
  const row = db
    .query(
      `
      SELECT 1 AS active
      FROM auth_users
      WHERE project_id = ?
        AND status = 'active'
      LIMIT 1
    `
    )
    .get(projectId) as { readonly active: number } | null

  return row !== null
}

function assertSignInSessionAudience(
  projectId: string,
  sessionAudience: string,
  storedAudience: string
): void {
  if (sessionAudience === storedAudience) {
    return
  }

  throw new AuthStorageError(
    "invalid_input",
    `[Sixb] Sign-in session audience '${sessionAudience}' does not match stored auth audience '${storedAudience}' for project '${projectId}'.`
  )
}

function assertCompletableDeviceAuthorization(
  authorization: DeviceAuthorizationRecord,
  input: CompleteDeviceAuthorizationInput
): void {
  if (authorization.deviceCodeHash !== input.deviceCodeHash) {
    throw new AuthStorageError(
      "invalid_device_authorization",
      "[Sixb] Invalid device authorization."
    )
  }
  if (authorization.status === "pending") {
    throw new AuthStorageError(
      "pending_device_authorization",
      "[Sixb] Device authorization is pending."
    )
  }
  if (authorization.status === "denied") {
    throw new AuthStorageError(
      "device_authorization_denied",
      "[Sixb] Device authorization was denied."
    )
  }
  if (
    authorization.status !== "approved" ||
    authorization.expiresAt <= input.completedAt ||
    !authorization.approvedUserId ||
    !authorization.approvedSessionId ||
    input.accessToken.projectId !== input.projectId ||
    input.accessToken.subjectType !== "user" ||
    input.accessToken.subjectId !== authorization.approvedUserId ||
    input.accessToken.createdBySessionId !== authorization.approvedSessionId
  ) {
    throw new AuthStorageError(
      "invalid_device_authorization",
      "[Sixb] Device authorization is invalid."
    )
  }
}
