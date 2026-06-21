import type {
  CompleteAuthSessionInput,
  CreateAuthSessionInput,
  GroupMembershipRecord,
  InvitationRecord,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  Principal,
  SessionRecord,
  UpsertAuthGroupMembershipInput,
  UserRecord,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import type {
  PgAuthGroupMembershipRow,
  PgAuthInvitationRow,
  PgAuthMagicLinkRow,
  PgAuthOidcAttemptRow,
  PgAuthSessionRow,
  PgAuthUserIdentityRow,
  PgAuthUserRow,
} from "./rows"
import {
  rowToGroupMembershipRecord,
  rowToInvitationRecord,
  rowToMagicLinkRecord,
  rowToOidcAuthorizationAttemptRecord,
  rowToSessionRecord,
  rowToUserRecord,
} from "./rows"

export type PgValue = string | number | Date | null

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

export function dateOrNow(value: Date | undefined): Date {
  return value ? new Date(value) : new Date()
}

export function hasEmptyFilter(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length === 0
}

export function appendPagination(
  query: string,
  params: PgValue[],
  nextIndex: number,
  input: { readonly limit?: number; readonly offset?: number }
): string {
  const offset = input.offset ?? 0

  if (input.limit !== undefined) {
    params.push(input.limit, offset)
    return `${query} LIMIT $${nextIndex++} OFFSET $${nextIndex++}`
  }

  if (offset > 0) {
    params.push(offset)
    return `${query} OFFSET $${nextIndex++}`
  }

  return query
}

export function placeholders(startIndex: number, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `$${startIndex + index}`)
}

export async function getUserRowById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthUserRow | null> {
  const [row] = await sql.unsafe<PgAuthUserRow[]>(
    `
      SELECT *
      FROM auth_users
      WHERE project_id = $1
        AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.id]
  )

  return row ?? null
}

export async function getUserById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<UserRecord | null> {
  const row = await getUserRowById(sql, params)
  return row ? rowToUserRecord(row) : null
}

export async function getUserRowByEmail(
  sql: SQLClient,
  params: { readonly projectId: string; readonly email: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthUserRow | null> {
  const [row] = await sql.unsafe<PgAuthUserRow[]>(
    `
      SELECT *
      FROM auth_users
      WHERE project_id = $1
        AND email = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, normalizeEmail(params.email)]
  )

  return row ?? null
}

export async function getUserByEmail(
  sql: SQLClient,
  params: { readonly projectId: string; readonly email: string }
): Promise<UserRecord | null> {
  const row = await getUserRowByEmail(sql, params)
  return row ? rowToUserRecord(row) : null
}

export async function requireUserById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<UserRecord> {
  const user = await getUserById(sql, params)
  if (!user) {
    throw new AuthStorageError(
      "missing_user",
      `[Sixb] User '${params.id}' not found for project '${params.projectId}'.`
    )
  }
  return user
}

export async function getIdentityRowBySubject(
  sql: SQLClient,
  params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthUserIdentityRow | null> {
  const [row] = await sql.unsafe<PgAuthUserIdentityRow[]>(
    `
      SELECT *
      FROM auth_user_identities
      WHERE project_id = $1
        AND strategy_id = $2
        AND subject = $3
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.strategyId, params.subject]
  )

  return row ?? null
}

export async function getSessionRowById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthSessionRow | null> {
  const [row] = await sql.unsafe<PgAuthSessionRow[]>(
    `
      SELECT *
      FROM auth_sessions
      WHERE project_id = $1
        AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.id]
  )

  return row ?? null
}

export async function getSessionById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<ReturnType<typeof rowToSessionRecord> | null> {
  const row = await getSessionRowById(sql, params)
  return row ? rowToSessionRecord(row) : null
}

export async function requireSessionById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<ReturnType<typeof rowToSessionRecord>> {
  const session = await getSessionById(sql, params)
  if (!session) {
    throw new AuthStorageError(
      "missing_session",
      `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
    )
  }
  return session
}

export async function getInvitationGroupIds(
  sql: SQLClient,
  params: { readonly projectId: string; readonly invitationId: string }
): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT group_id
    FROM auth_invitation_groups
    WHERE project_id = ${params.projectId}
      AND invitation_id = ${params.invitationId}
    ORDER BY position ASC, group_id ASC
  `) as Array<{ readonly group_id: string }>

  return rows.map((row) => row.group_id)
}

export async function getInvitationById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<InvitationRecord | null> {
  const [row] = await sql.unsafe<PgAuthInvitationRow[]>(
    `
      SELECT *
      FROM auth_invitations
      WHERE project_id = $1
        AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.id]
  )

  return row ? invitationRowToRecord(sql, row) : null
}

export async function requireInvitationById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<InvitationRecord> {
  const invitation = await getInvitationById(sql, params, options)
  if (!invitation) {
    throw new AuthStorageError(
      "missing_invitation",
      `[Sixb] Invitation '${params.id}' not found for project '${params.projectId}'.`
    )
  }
  return invitation
}

export async function getActiveInvitationByEmail(
  sql: SQLClient,
  params: { readonly projectId: string; readonly email: string; readonly now: Date },
  options: { readonly forUpdate?: boolean } = {}
): Promise<InvitationRecord | null> {
  const [row] = await sql.unsafe<PgAuthInvitationRow[]>(
    `
      SELECT *
      FROM auth_invitations
      WHERE project_id = $1
        AND email = $2
        AND status = 'pending'
        AND expires_at > $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, normalizeEmail(params.email), params.now]
  )

  return row ? invitationRowToRecord(sql, row) : null
}

export async function replaceInvitationGroups(
  sql: SQLClient,
  params: {
    readonly projectId: string
    readonly invitationId: string
    readonly groupIds: readonly string[]
  }
): Promise<void> {
  await sql`
    DELETE FROM auth_invitation_groups
    WHERE project_id = ${params.projectId}
      AND invitation_id = ${params.invitationId}
  `

  for (const [index, groupId] of params.groupIds.entries()) {
    await sql`
      INSERT INTO auth_invitation_groups (
        project_id,
        invitation_id,
        group_id,
        position
      ) VALUES (
        ${params.projectId},
        ${params.invitationId},
        ${groupId},
        ${index}
      )
    `
  }
}

export async function getMagicLinkRowById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthMagicLinkRow | null> {
  const [row] = await sql.unsafe<PgAuthMagicLinkRow[]>(
    `
      SELECT *
      FROM auth_magic_links
      WHERE project_id = $1
        AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.id]
  )

  return row ?? null
}

export async function getMagicLinkById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<MagicLinkRecord | null> {
  const row = await getMagicLinkRowById(sql, params)
  return row ? rowToMagicLinkRecord(row) : null
}

export async function consumeMagicLink(
  sql: SQLClient,
  params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }
): Promise<MagicLinkRecord> {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const id = assertNonEmpty(params.id, "Magic link id")
  const tokenHash = assertNonEmpty(params.tokenHash, "Magic link token hash")
  const row = await getMagicLinkRowById(sql, { projectId, id }, { forUpdate: true })

  if (!row) {
    throw new AuthStorageError(
      "missing_magic_link",
      `[Sixb] Magic link '${id}' not found for project '${projectId}'.`
    )
  }

  assertMagicLinkUsable(projectId, id, tokenHash, params.consumedAt, row)

  await sql`
    UPDATE auth_magic_links
    SET consumed_at = ${params.consumedAt}
    WHERE project_id = ${projectId}
      AND id = ${id}
  `

  return rowToMagicLinkRecord({
    ...row,
    consumed_at: params.consumedAt,
  })
}

export async function getOidcAttemptRowById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<PgAuthOidcAttemptRow | null> {
  const [row] = await sql.unsafe<PgAuthOidcAttemptRow[]>(
    `
      SELECT *
      FROM auth_oidc_authorization_attempts
      WHERE project_id = $1
        AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [params.projectId, params.id]
  )

  return row ?? null
}

export async function getOidcAttemptById(
  sql: SQLClient,
  params: { readonly projectId: string; readonly id: string }
): Promise<OidcAuthorizationAttemptRecord | null> {
  const row = await getOidcAttemptRowById(sql, params)
  return row ? rowToOidcAuthorizationAttemptRecord(row) : null
}

export async function consumeOidcAttempt(
  sql: SQLClient,
  params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }
): Promise<OidcAuthorizationAttemptRecord> {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const id = assertNonEmpty(params.id, "OIDC authorization attempt id")
  const stateHash = assertNonEmpty(params.stateHash, "OIDC state hash")
  const row = await getOidcAttemptRowById(sql, { projectId, id }, { forUpdate: true })

  if (!row) {
    throw new AuthStorageError(
      "missing_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' not found for project '${projectId}'.`
    )
  }

  assertOidcAttemptUsable(projectId, id, stateHash, params.consumedAt, row)

  await sql`
    UPDATE auth_oidc_authorization_attempts
    SET consumed_at = ${params.consumedAt}
    WHERE project_id = ${projectId}
      AND id = ${id}
  `

  return rowToOidcAuthorizationAttemptRecord({
    ...row,
    consumed_at: params.consumedAt,
  })
}

export async function validateCompleteSessionInput(
  sql: SQLClient,
  projectId: string,
  session: CompleteAuthSessionInput
): Promise<void> {
  const sessionId = assertNonEmpty(session.id, "Session id")
  assertNonEmpty(session.audience, "Session audience")
  assertNonEmpty(session.tokenHash, "Session token hash")
  await assertSessionIdAvailable(sql, projectId, sessionId)
}

export async function assertSessionIdAvailable(
  sql: SQLClient,
  projectId: string,
  sessionId: string
): Promise<void> {
  if (await getSessionRowById(sql, { projectId, id: sessionId })) {
    throw new AuthStorageError(
      "duplicate_session",
      `[Sixb] Session '${sessionId}' already exists for project '${projectId}'.`
    )
  }
}

export async function createSession(
  sql: SQLClient,
  input: CreateAuthSessionInput
): Promise<SessionRecord> {
  const id = assertNonEmpty(input.id, "Session id")
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
  const audience = assertNonEmpty(input.audience, "Session audience")
  const tokenHash = assertNonEmpty(input.tokenHash, "Session token hash")

  await requireUserById(sql, { projectId, id: userId })
  await assertSessionIdAvailable(sql, projectId, id)

  try {
    const [row] = await sql<PgAuthSessionRow[]>`
      INSERT INTO auth_sessions (
        project_id,
        id,
        user_id,
        strategy_id,
        audience,
        token_hash,
        created_at,
        expires_at,
        user_agent,
        ip_address
      ) VALUES (
        ${projectId},
        ${id},
        ${userId},
        ${strategyId},
        ${audience},
        ${tokenHash},
        ${input.createdAt},
        ${input.expiresAt},
        ${input.userAgent ?? null},
        ${input.ipAddress ?? null}
      )
      RETURNING *
    `

    return rowToSessionRecord(row)
  } catch (error) {
    mapUniqueConstraintError(
      error,
      "duplicate_session",
      `[Sixb] Session '${id}' already exists for project '${projectId}'.`
    )
  }
}

export async function revokeActiveSessionsForUser(
  sql: SQLClient,
  params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: string
    readonly revokedAt: Date
  }
): Promise<readonly SessionRecord[]> {
  const rows =
    params.audience === undefined
      ? await sql<PgAuthSessionRow[]>`
      SELECT *
      FROM auth_sessions
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
        AND revoked_at IS NULL
        AND expires_at > ${params.revokedAt}
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `
      : await sql<PgAuthSessionRow[]>`
      SELECT *
      FROM auth_sessions
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
        AND audience = ${params.audience}
        AND revoked_at IS NULL
        AND expires_at > ${params.revokedAt}
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `

  if (params.audience === undefined) {
    await sql`
      UPDATE auth_sessions
      SET revoked_at = ${params.revokedAt}
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
        AND revoked_at IS NULL
        AND expires_at > ${params.revokedAt}
    `
  } else {
    await sql`
      UPDATE auth_sessions
      SET revoked_at = ${params.revokedAt}
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
        AND audience = ${params.audience}
        AND revoked_at IS NULL
        AND expires_at > ${params.revokedAt}
    `
  }

  return rows.map((row) =>
    rowToSessionRecord({
      ...row,
      revoked_at: params.revokedAt,
    })
  )
}

export async function upsertGroupMembership(
  sql: SQLClient,
  input: UpsertAuthGroupMembershipInput
): Promise<GroupMembershipRecord> {
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const groupId = assertNonEmpty(input.groupId, "Group id")

  await requireUserById(sql, { projectId, id: userId })

  await sql`
    INSERT INTO auth_group_memberships (
      project_id,
      user_id,
      group_id,
      source,
      created_at
    ) VALUES (
      ${projectId},
      ${userId},
      ${groupId},
      ${input.source},
      ${dateOrNow(input.createdAt)}
    )
    ON CONFLICT (project_id, user_id, group_id) DO NOTHING
  `

  const membership = await getGroupMembership(sql, { projectId, userId, groupId })
  if (!membership) {
    throw new AuthStorageError(
      "missing_user",
      `[Sixb] Failed to load group membership '${groupId}' for user '${userId}'.`
    )
  }
  return membership
}

export async function getGroupMembership(
  sql: SQLClient,
  params: { readonly projectId: string; readonly userId: string; readonly groupId: string }
): Promise<GroupMembershipRecord | null> {
  const [row] = await sql<PgAuthGroupMembershipRow[]>`
    SELECT *
    FROM auth_group_memberships
    WHERE project_id = ${params.projectId}
      AND user_id = ${params.userId}
      AND group_id = ${params.groupId}
  `

  return row ? rowToGroupMembershipRecord(row) : null
}

export async function listMembershipsForUser(
  sql: SQLClient,
  params: { readonly projectId: string; readonly userId: string }
): Promise<readonly GroupMembershipRecord[]> {
  const rows = await sql<PgAuthGroupMembershipRow[]>`
    SELECT *
    FROM auth_group_memberships
    WHERE project_id = ${params.projectId}
      AND user_id = ${params.userId}
    ORDER BY group_id ASC
  `

  return rows.map(rowToGroupMembershipRecord)
}

export async function revokeActiveMagicLinksForEmail(
  sql: SQLClient,
  params: { readonly projectId: string; readonly email: string; readonly revokedAt: Date }
): Promise<readonly MagicLinkRecord[]> {
  const email = normalizeEmail(params.email)
  const rows = await sql<PgAuthMagicLinkRow[]>`
    SELECT *
    FROM auth_magic_links
    WHERE project_id = ${params.projectId}
      AND email = ${email}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${params.revokedAt}
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  `

  await sql`
    UPDATE auth_magic_links
    SET revoked_at = ${params.revokedAt}
    WHERE project_id = ${params.projectId}
      AND email = ${email}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${params.revokedAt}
  `

  return rows.map((row) =>
    rowToMagicLinkRecord({
      ...row,
      revoked_at: params.revokedAt,
    })
  )
}

export function invitationCreatorColumns(principal: Principal | undefined): {
  readonly createdByUserId: string | null
  readonly createdByServiceAccountId: string | null
  readonly createdBySystemId: string | null
} {
  return {
    createdByUserId: principal?.type === "user" ? principal.id : null,
    createdByServiceAccountId: principal?.type === "serviceAccount" ? principal.id : null,
    createdBySystemId: principal?.type === "system" ? principal.id : null,
  }
}

export function assertMagicLinkUsable(
  projectId: string,
  id: string,
  tokenHash: string,
  at: Date,
  row: PgAuthMagicLinkRow
): void {
  if (row.token_hash !== tokenHash || row.consumed_at || row.revoked_at) {
    throw new AuthStorageError(
      "invalid_magic_link",
      `[Sixb] Magic link '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (new Date(row.expires_at) <= at) {
    throw new AuthStorageError(
      "expired_magic_link",
      `[Sixb] Magic link '${id}' is expired for project '${projectId}'.`
    )
  }
}

export function assertOidcAttemptUsable(
  projectId: string,
  id: string,
  stateHash: string,
  at: Date,
  row: PgAuthOidcAttemptRow
): void {
  if (row.state_hash !== stateHash || row.consumed_at) {
    throw new AuthStorageError(
      "invalid_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is not valid for project '${projectId}'.`
    )
  }

  if (new Date(row.expires_at) <= at) {
    throw new AuthStorageError(
      "expired_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is expired for project '${projectId}'.`
    )
  }
}

export function mapUniqueConstraintError(
  error: unknown,
  code:
    | "duplicate_access_token"
    | "duplicate_identity"
    | "duplicate_invitation"
    | "duplicate_magic_link"
    | "duplicate_oidc_attempt"
    | "duplicate_service_account"
    | "duplicate_session"
    | "duplicate_user",
  message: string
): never {
  if (isUniqueViolation(error)) {
    throw new AuthStorageError(code, message)
  }

  throw error
}

async function invitationRowToRecord(
  sql: SQLClient,
  row: PgAuthInvitationRow
): Promise<InvitationRecord> {
  return rowToInvitationRecord(
    row,
    await getInvitationGroupIds(sql, {
      projectId: row.project_id,
      invitationId: row.id,
    })
  )
}
