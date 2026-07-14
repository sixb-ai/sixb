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
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SQLClient } from "../pg-client"
import {
  authLockKey,
  lockAdvisoryKeys,
  type PgStoreClient,
  runPgTransaction,
} from "../transactions"
import { PgAuthAccessTokenStore } from "./access-tokens"
import { PgAuthGroupMembershipStore } from "./group-memberships"
import { PgAuthUserIdentityStore } from "./identities"
import { PgAuthInvitationStore } from "./invitations"
import { PgAuthMagicLinkStore } from "./magic-links"
import { PgAuthOidcAuthorizationAttemptStore } from "./oidc-attempts"
import type {
  PgAuthMagicLinkRow,
  PgAuthOidcAttemptRow,
  PgAuthUserIdentityRow,
  PgAuthUserRow,
} from "./rows"
import { rowToIdentityRecord, rowToUserRecord, serializeOptionalRecord } from "./rows"
import { PgAuthServiceAccountGroupMembershipStore } from "./service-account-group-memberships"
import { PgAuthServiceAccountStore } from "./service-accounts"
import { PgAuthSessionStore } from "./sessions"
import {
  assertMagicLinkUsable,
  assertNonEmpty,
  assertOidcAttemptUsable,
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
  upsertGroupMembership,
  validateCompleteSessionInput,
} from "./shared"
import { PgAuthUserStore } from "./users"

interface AuthTransactionError {
  readonly error: AuthStorageError
}

export interface PgAuthStorageOptions {
  readonly sql: PgStoreClient
}

export class PgAuthStorage implements AuthStorage {
  private readonly sql: PgStoreClient

  readonly users: PgAuthUserStore
  readonly identities: PgAuthUserIdentityStore
  readonly serviceAccounts: PgAuthServiceAccountStore
  readonly serviceAccountGroupMemberships: PgAuthServiceAccountGroupMembershipStore
  readonly sessions: PgAuthSessionStore
  readonly accessTokens: PgAuthAccessTokenStore
  readonly invitations: PgAuthInvitationStore
  readonly groupMemberships: PgAuthGroupMembershipStore
  readonly magicLinks: PgAuthMagicLinkStore
  readonly oidcAuthorizationAttempts: PgAuthOidcAuthorizationAttemptStore

  constructor(options: PgAuthStorageOptions) {
    this.sql = options.sql
    this.users = new PgAuthUserStore(this.sql)
    this.identities = new PgAuthUserIdentityStore(this.sql)
    this.serviceAccounts = new PgAuthServiceAccountStore(this.sql)
    this.serviceAccountGroupMemberships = new PgAuthServiceAccountGroupMembershipStore(this.sql)
    this.sessions = new PgAuthSessionStore(this.sql)
    this.accessTokens = new PgAuthAccessTokenStore(this.sql)
    this.invitations = new PgAuthInvitationStore(this.sql)
    this.groupMemberships = new PgAuthGroupMembershipStore(this.sql)
    this.magicLinks = new PgAuthMagicLinkStore(this.sql)
    this.oidcAuthorizationAttempts = new PgAuthOidcAuthorizationAttemptStore(this.sql)
  }

  async completeMagicLinkSignIn(
    input: CompleteMagicLinkSignInInput
  ): Promise<CompleteSignInResult> {
    const result = await runPgTransaction(
      this.sql,
      async (tx): Promise<CompleteSignInResult | AuthTransactionError> => {
        const projectId = assertNonEmpty(input.projectId, "Project id")
        const completedAt = new Date(input.completedAt)
        const initialMagicLink = await getMagicLinkRowById(tx, {
          projectId,
          id: input.magicLinkId,
        })

        if (!initialMagicLink) {
          throw new AuthStorageError(
            "missing_magic_link",
            `[Sixb] Magic link '${input.magicLinkId}' not found for project '${projectId}'.`
          )
        }

        const email = normalizeEmail(initialMagicLink.email)
        await lockAdvisoryKeys(tx, [
          authLockKey("bootstrap", projectId),
          authLockKey("invitations", projectId, email),
          authLockKey("magic-links", projectId, email),
          authLockKey("users", projectId, email),
        ])

        const magicLink = await getMagicLinkRowById(
          tx,
          {
            projectId,
            id: input.magicLinkId,
          },
          { forUpdate: true }
        )

        this.assertMagicLinkUsable(
          projectId,
          input.magicLinkId,
          input.tokenHash,
          completedAt,
          magicLink
        )

        const existingUserRow = await getUserRowByEmail(
          tx,
          {
            projectId,
            email,
          },
          { forUpdate: true }
        )
        const activeInvitation = await getActiveInvitationByEmail(
          tx,
          {
            projectId,
            email,
            now: completedAt,
          },
          { forUpdate: true }
        )
        const shouldCreateUser = !existingUserRow
        const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

        if (existingUserRow?.status === "suspended") {
          await consumeMagicLink(tx, {
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
          await consumeMagicLink(tx, {
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
          (await hasActiveUsers(tx, projectId))
        ) {
          await consumeMagicLink(tx, {
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

        await validateCompleteSessionInput(tx, projectId, input.session)
        assertSignInSessionAudience(projectId, input.session.audience, magicLink.audience)

        let newUserId: string | undefined
        if (shouldCreateUser) {
          newUserId = assertNonEmpty(input.newUserId, "User id")
          if (await getUserRowById(tx, { projectId, id: newUserId })) {
            throw new AuthStorageError(
              "duplicate_user",
              `[Sixb] User '${newUserId}' already exists for project '${projectId}'.`
            )
          }
        }

        const sessionUserId = existingUserRow?.id ?? newUserId ?? input.newUserId
        await lockAdvisoryKeys(tx, [authLockKey("sessions", projectId, sessionUserId)])

        await consumeMagicLink(tx, {
          projectId,
          id: input.magicLinkId,
          tokenHash: input.tokenHash,
          consumedAt: completedAt,
        })

        const user = existingUserRow
          ? rowToUserRecord(existingUserRow)
          : await this.insertUser(tx, {
              id: newUserId ?? assertNonEmpty(input.newUserId, "User id"),
              projectId,
              email,
              displayName: input.newUserDisplayName,
              avatarUrl: input.newUserAvatarUrl,
              createdAt: completedAt,
            })

        const invitation = await this.acceptInvitationAndApplyGroups(tx, {
          activeInvitation,
          completedAt,
          projectId,
          user,
        })
        const groupMemberships = await this.applyManualGroups(tx, {
          completedAt,
          existing: invitation.groupMemberships,
          groupIds: manualGroupIds,
          projectId,
          userId: user.id,
        })
        const session = await this.createSignInSession(tx, {
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
    const result = await runPgTransaction(
      this.sql,
      async (tx): Promise<CompleteSignInResult | AuthTransactionError> => {
        const projectId = assertNonEmpty(input.projectId, "Project id")
        const completedAt = new Date(input.completedAt)
        const attempt = await getOidcAttemptRowById(
          tx,
          {
            projectId,
            id: input.oidcAuthorizationAttemptId,
          },
          { forUpdate: true }
        )

        this.assertOidcAttemptUsable(
          projectId,
          input.oidcAuthorizationAttemptId,
          input.stateHash,
          completedAt,
          attempt
        )

        const subject = assertNonEmpty(input.subject, "Subject")
        const email = normalizeEmail(input.email)
        await lockAdvisoryKeys(tx, [
          authLockKey("bootstrap", projectId),
          authLockKey("invitations", projectId, email),
          authLockKey("identities", projectId, attempt.strategy_id, subject),
          authLockKey("users", projectId, email),
        ])

        const identity = await getIdentityRowBySubject(
          tx,
          {
            projectId,
            strategyId: attempt.strategy_id,
            subject,
          },
          { forUpdate: true }
        )
        const activeInvitation = identity
          ? null
          : await getActiveInvitationByEmail(
              tx,
              {
                projectId,
                email,
                now: completedAt,
              },
              { forUpdate: true }
            )
        let userRow = identity
          ? await getUserRowById(tx, { projectId, id: identity.user_id }, { forUpdate: true })
          : await getUserRowByEmail(tx, { projectId, email }, { forUpdate: true })
        const shouldCreateUser = !identity && !userRow
        const manualGroupIds = normalizeGroupIds(input.manualGroupIds)

        if (identity && !userRow) {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
          return {
            error: new AuthStorageError(
              "missing_user",
              `[Sixb] User '${identity.user_id}' not found for linked OIDC identity.`
            ),
          }
        }

        if (!identity && userRow && (!input.autoLinkByVerifiedEmail || !input.emailVerified)) {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
          return {
            error: new AuthStorageError(
              "email_link_not_allowed",
              `[Sixb] OIDC identity cannot auto-link to user '${userRow.id}' for project '${projectId}'.`
            ),
          }
        }

        if (userRow?.status === "suspended") {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
          return {
            error: new AuthStorageError(
              "suspended_user",
              `[Sixb] User '${userRow.id}' is suspended for project '${projectId}'.`
            ),
          }
        }

        if (shouldCreateUser && !input.emailVerified) {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        if (shouldCreateUser && !activeInvitation && !input.allowUserCreationWithoutInvitation) {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
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
          (await hasActiveUsers(tx, projectId))
        ) {
          await this.consumeOidcAttempt(input, completedAt, projectId, tx)
          return {
            error: new AuthStorageError(
              "user_creation_not_allowed",
              `[Sixb] OIDC authorization attempt '${input.oidcAuthorizationAttemptId}' cannot create a user for project '${projectId}'.`
            ),
          }
        }

        await validateCompleteSessionInput(tx, projectId, input.session)
        assertSignInSessionAudience(projectId, input.session.audience, attempt.audience)

        let newUserId: string | undefined
        if (shouldCreateUser) {
          newUserId = assertNonEmpty(input.newUserId, "User id")
          if (await getUserRowById(tx, { projectId, id: newUserId })) {
            throw new AuthStorageError(
              "duplicate_user",
              `[Sixb] User '${newUserId}' already exists for project '${projectId}'.`
            )
          }
        }

        await lockAdvisoryKeys(tx, [
          authLockKey("sessions", projectId, userRow?.id ?? newUserId ?? input.newUserId),
        ])
        await this.consumeOidcAttempt(input, completedAt, projectId, tx)

        let user: UserRecord
        if (!userRow) {
          user = await this.insertUser(tx, {
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
            created_at: user.createdAt,
            updated_at: user.updatedAt,
          }
        } else {
          user = rowToUserRecord(userRow)
        }

        const invitation = await this.acceptInvitationAndApplyGroups(tx, {
          activeInvitation,
          completedAt,
          projectId,
          user,
        })
        const groupMemberships = await this.applyManualGroups(tx, {
          completedAt,
          existing: invitation.groupMemberships,
          groupIds: manualGroupIds,
          projectId,
          userId: user.id,
        })
        const nextIdentity = await this.upsertIdentity(tx, {
          projectId,
          strategyId: attempt.strategy_id,
          subject,
          userId: user.id,
          claims: input.claims,
          createdAt: identity ? new Date(identity.created_at) : completedAt,
          updatedAt: completedAt,
        })
        const session = await this.createSignInSession(tx, {
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
    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [authLockKey("sessions", input.projectId, input.userId)])
      const existing = await getUserRowById(
        tx,
        {
          projectId: input.projectId,
          id: input.userId,
        },
        { forUpdate: true }
      )

      if (!existing) {
        throw new AuthStorageError(
          "missing_user",
          `[Sixb] User '${input.userId}' not found for project '${input.projectId}'.`
        )
      }

      const [updated] = await tx<PgAuthUserRow[]>`
        UPDATE auth_users
        SET status = 'suspended',
            updated_at = ${input.suspendedAt}
        WHERE project_id = ${input.projectId}
          AND id = ${input.userId}
        RETURNING *
      `

      await revokeActiveSessionsForUser(tx, {
        projectId: input.projectId,
        userId: input.userId,
        revokedAt: input.suspendedAt,
      })

      return rowToUserRecord(updated)
    })
  }

  private assertMagicLinkUsable(
    projectId: string,
    id: string,
    tokenHash: string,
    completedAt: Date,
    row: PgAuthMagicLinkRow | null
  ): asserts row is PgAuthMagicLinkRow {
    if (!row) {
      throw new AuthStorageError(
        "missing_magic_link",
        `[Sixb] Magic link '${id}' not found for project '${projectId}'.`
      )
    }

    assertMagicLinkUsable(projectId, id, tokenHash, completedAt, row)
  }

  private assertOidcAttemptUsable(
    projectId: string,
    id: string,
    stateHash: string,
    completedAt: Date,
    row: PgAuthOidcAttemptRow | null
  ): asserts row is PgAuthOidcAttemptRow {
    if (!row) {
      throw new AuthStorageError(
        "missing_oidc_attempt",
        `[Sixb] OIDC authorization attempt '${id}' not found for project '${projectId}'.`
      )
    }

    assertOidcAttemptUsable(projectId, id, stateHash, completedAt, row)
  }

  private async insertUser(
    sql: SQLClient,
    input: {
      readonly id: string
      readonly projectId: string
      readonly email: string
      readonly displayName?: string
      readonly avatarUrl?: string
      readonly createdAt: Date
    }
  ): Promise<UserRecord> {
    try {
      const [row] = await sql<PgAuthUserRow[]>`
        INSERT INTO auth_users (
          project_id,
          id,
          email,
          display_name,
          avatar_url,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.email},
          ${input.displayName ?? null},
          ${input.avatarUrl ?? null},
          ${"active"},
          ${input.createdAt},
          ${input.createdAt}
        )
        RETURNING *
      `

      return rowToUserRecord(row)
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_user",
        `[Sixb] User '${input.id}' already exists for project '${input.projectId}'.`
      )
    }
  }

  private async acceptInvitationAndApplyGroups(
    sql: SQLClient,
    input: {
      readonly activeInvitation: InvitationRecord | null
      readonly completedAt: Date
      readonly projectId: string
      readonly user: UserRecord
    }
  ): Promise<{
    readonly invitation?: InvitationRecord
    readonly groupMemberships: readonly GroupMembershipRecord[]
  }> {
    if (!input.activeInvitation) {
      return { groupMemberships: [] }
    }

    await sql`
      UPDATE auth_invitations
      SET status = 'accepted',
          accepted_at = ${input.completedAt},
          updated_at = ${input.completedAt}
      WHERE project_id = ${input.projectId}
        AND id = ${input.activeInvitation.id}
    `

    const invitation: InvitationRecord = {
      ...input.activeInvitation,
      status: "accepted",
      acceptedAt: new Date(input.completedAt),
      updatedAt: new Date(input.completedAt),
    }
    const groupMemberships: GroupMembershipRecord[] = []
    for (const groupId of input.activeInvitation.groupIds) {
      groupMemberships.push(
        await upsertGroupMembership(sql, {
          projectId: input.projectId,
          userId: input.user.id,
          groupId,
          source: "invitation",
          createdAt: input.completedAt,
        })
      )
    }

    return { invitation, groupMemberships }
  }

  private async applyManualGroups(
    sql: SQLClient,
    input: {
      readonly completedAt: Date
      readonly existing: readonly GroupMembershipRecord[]
      readonly groupIds: readonly string[]
      readonly projectId: string
      readonly userId: string
    }
  ): Promise<readonly GroupMembershipRecord[]> {
    const groupMemberships = [...input.existing]

    for (const groupId of input.groupIds) {
      groupMemberships.push(
        await upsertGroupMembership(sql, {
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

  private async createSignInSession(
    sql: SQLClient,
    input: {
      readonly projectId: string
      readonly strategyId: string
      readonly session: CompleteMagicLinkSignInInput["session"]
      readonly userId: string
    }
  ): Promise<SessionRecord> {
    await lockAdvisoryKeys(sql, [
      authLockKey("sessions", input.projectId, input.userId),
      authLockKey("sessions", input.projectId, input.userId, input.session.audience),
    ])

    return createSession(sql, {
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

  private async consumeOidcAttempt(
    input: CompleteOidcSignInInput,
    completedAt: Date,
    projectId: string,
    sql: SQLClient
  ): Promise<void> {
    await consumeOidcAttempt(sql, {
      projectId,
      id: input.oidcAuthorizationAttemptId,
      stateHash: input.stateHash,
      consumedAt: completedAt,
    })
  }

  private async upsertIdentity(
    sql: SQLClient,
    input: {
      readonly projectId: string
      readonly strategyId: string
      readonly subject: string
      readonly userId: string
      readonly claims?: Readonly<Record<string, unknown>>
      readonly createdAt: Date
      readonly updatedAt: Date
    }
  ): Promise<UserIdentityRecord> {
    const [row] = await sql<PgAuthUserIdentityRow[]>`
      INSERT INTO auth_user_identities (
        project_id,
        strategy_id,
        subject,
        user_id,
        claims,
        created_at,
        updated_at
      ) VALUES (
        ${input.projectId},
        ${input.strategyId},
        ${input.subject},
        ${input.userId},
        ${serializeOptionalRecord(input.claims)}::text::jsonb,
        ${input.createdAt},
        ${input.updatedAt}
      )
      ON CONFLICT (project_id, strategy_id, subject)
      DO UPDATE SET
        user_id = excluded.user_id,
        claims = excluded.claims,
        updated_at = excluded.updated_at
      RETURNING *
    `

    return rowToIdentityRecord(row)
  }
}

async function hasActiveUsers(sql: SQLClient, projectId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS active
    FROM auth_users
    WHERE project_id = ${projectId}
      AND status = 'active'
    LIMIT 1
  `) as Array<{ readonly active: number }>

  return rows.length > 0
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
