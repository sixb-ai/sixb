import type { Database } from "bun:sqlite"
import type { AuthSessionAudience } from "@sixb/core"
import type {
  CompleteAuthSessionInput,
  CreateAuthSessionInput,
  GroupMembershipRecord,
  InvitationRecord,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  UpsertAuthGroupMembershipInput,
} from "@sixb/core/storage"
import { AuthStorageError } from "@sixb/core/storage"
import { isUniqueConstraintError } from "../storage-errors"
import type {
  SqliteAuthGroupMembershipRow,
  SqliteAuthInvitationRow,
  SqliteAuthMagicLinkRow,
  SqliteAuthOidcAttemptRow,
  SqliteAuthSessionRow,
  SqliteAuthUserIdentityRow,
  SqliteAuthUserRow,
} from "./rows"
import {
  rowToGroupMembershipRecord,
  rowToInvitationRecord,
  rowToMagicLinkRecord,
  rowToOidcAuthorizationAttemptRecord,
  rowToSessionRecord,
} from "./rows"

export type SqliteValue = string | number | null

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

export function toIso(value: Date): string {
  return value.toISOString()
}

export function hasEmptyFilter(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length === 0
}

export function appendPagination(
  query: string,
  args: SqliteValue[],
  input: { readonly limit?: number; readonly offset?: number }
): string {
  const offset = input.offset ?? 0

  if (input.limit !== undefined) {
    args.push(input.limit, offset)
    return `${query} LIMIT ? OFFSET ?`
  }

  if (offset > 0) {
    args.push(offset)
    return `${query} LIMIT -1 OFFSET ?`
  }

  return query
}

export function getUserRowById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): SqliteAuthUserRow | null {
  return db
    .query("SELECT * FROM auth_users WHERE project_id = ? AND id = ?")
    .get(params.projectId, params.id) as SqliteAuthUserRow | null
}

export function getUserRowByEmail(
  db: Database,
  params: { readonly projectId: string; readonly email: string }
): SqliteAuthUserRow | null {
  return db
    .query("SELECT * FROM auth_users WHERE project_id = ? AND email = ?")
    .get(params.projectId, normalizeEmail(params.email)) as SqliteAuthUserRow | null
}

export function getIdentityRowBySubject(
  db: Database,
  params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  }
): SqliteAuthUserIdentityRow | null {
  return db
    .query(
      `
      SELECT *
      FROM auth_user_identities
      WHERE project_id = ?
        AND strategy_id = ?
        AND subject = ?
    `
    )
    .get(params.projectId, params.strategyId, params.subject) as SqliteAuthUserIdentityRow | null
}

export function getSessionRowById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): SqliteAuthSessionRow | null {
  return db
    .query("SELECT * FROM auth_sessions WHERE project_id = ? AND id = ?")
    .get(params.projectId, params.id) as SqliteAuthSessionRow | null
}

export function getSessionById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): ReturnType<typeof rowToSessionRecord> | null {
  const row = getSessionRowById(db, params)
  return row ? rowToSessionRecord(row) : null
}

export function requireSessionById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): ReturnType<typeof rowToSessionRecord> {
  const session = getSessionById(db, params)
  if (!session) {
    throw new AuthStorageError(
      "missing_session",
      `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
    )
  }
  return session
}

export function getInvitationGroupIds(
  db: Database,
  params: { readonly projectId: string; readonly invitationId: string }
): readonly string[] {
  const rows = db
    .query(
      `
      SELECT group_id
      FROM auth_invitation_groups
      WHERE project_id = ?
        AND invitation_id = ?
      ORDER BY position ASC, group_id ASC
    `
    )
    .all(params.projectId, params.invitationId) as Array<{ readonly group_id: string }>

  return rows.map((row) => row.group_id)
}

export function getInvitationById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): InvitationRecord | null {
  const row = db
    .query("SELECT * FROM auth_invitations WHERE project_id = ? AND id = ?")
    .get(params.projectId, params.id) as SqliteAuthInvitationRow | null

  return row ? invitationRowToRecord(db, row) : null
}

export function requireInvitationById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): InvitationRecord {
  const invitation = getInvitationById(db, params)
  if (!invitation) {
    throw new AuthStorageError(
      "missing_invitation",
      `[Sixb] Invitation '${params.id}' not found for project '${params.projectId}'.`
    )
  }
  return invitation
}

export function getActiveInvitationByEmail(
  db: Database,
  params: { readonly projectId: string; readonly email: string; readonly now: Date }
): InvitationRecord | null {
  const row = db
    .query(
      `
      SELECT *
      FROM auth_invitations
      WHERE project_id = ?
        AND email = ?
        AND status = 'pending'
        AND expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `
    )
    .get(
      params.projectId,
      normalizeEmail(params.email),
      toIso(params.now)
    ) as SqliteAuthInvitationRow | null

  return row ? invitationRowToRecord(db, row) : null
}

export function replaceInvitationGroups(
  db: Database,
  params: {
    readonly projectId: string
    readonly invitationId: string
    readonly groupIds: readonly string[]
  }
): void {
  db.query("DELETE FROM auth_invitation_groups WHERE project_id = ? AND invitation_id = ?").run(
    params.projectId,
    params.invitationId
  )

  for (const [index, groupId] of params.groupIds.entries()) {
    db.query(
      `
      INSERT INTO auth_invitation_groups (
        project_id,
        invitation_id,
        group_id,
        position
      ) VALUES (?, ?, ?, ?)
    `
    ).run(params.projectId, params.invitationId, groupId, index)
  }
}

export function getMagicLinkRowById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): SqliteAuthMagicLinkRow | null {
  return db
    .query("SELECT * FROM auth_magic_links WHERE project_id = ? AND id = ?")
    .get(params.projectId, params.id) as SqliteAuthMagicLinkRow | null
}

export function getMagicLinkById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): MagicLinkRecord | null {
  const row = getMagicLinkRowById(db, params)
  return row ? rowToMagicLinkRecord(row) : null
}

export function consumeMagicLink(
  db: Database,
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
  const row = getMagicLinkRowById(db, { projectId, id })

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

  if (new Date(row.expires_at) <= params.consumedAt) {
    throw new AuthStorageError(
      "expired_magic_link",
      `[Sixb] Magic link '${id}' is expired for project '${projectId}'.`
    )
  }

  db.query(
    `
    UPDATE auth_magic_links
    SET consumed_at = ?
    WHERE project_id = ?
      AND id = ?
  `
  ).run(toIso(params.consumedAt), projectId, id)

  return rowToMagicLinkRecord({
    ...row,
    consumed_at: toIso(params.consumedAt),
  })
}

export function getOidcAttemptRowById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): SqliteAuthOidcAttemptRow | null {
  return db
    .query("SELECT * FROM auth_oidc_authorization_attempts WHERE project_id = ? AND id = ?")
    .get(params.projectId, params.id) as SqliteAuthOidcAttemptRow | null
}

export function getOidcAttemptById(
  db: Database,
  params: { readonly projectId: string; readonly id: string }
): OidcAuthorizationAttemptRecord | null {
  const row = getOidcAttemptRowById(db, params)
  return row ? rowToOidcAuthorizationAttemptRecord(row) : null
}

export function consumeOidcAttempt(
  db: Database,
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
  const row = getOidcAttemptRowById(db, { projectId, id })

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

  if (new Date(row.expires_at) <= params.consumedAt) {
    throw new AuthStorageError(
      "expired_oidc_attempt",
      `[Sixb] OIDC authorization attempt '${id}' is expired for project '${projectId}'.`
    )
  }

  db.query(
    `
    UPDATE auth_oidc_authorization_attempts
    SET consumed_at = ?
    WHERE project_id = ?
      AND id = ?
  `
  ).run(toIso(params.consumedAt), projectId, id)

  return rowToOidcAuthorizationAttemptRecord({
    ...row,
    consumed_at: toIso(params.consumedAt),
  })
}

export function validateCompleteSessionInput(
  db: Database,
  projectId: string,
  session: CompleteAuthSessionInput
): void {
  const sessionId = assertNonEmpty(session.id, "Session id")
  assertNonEmpty(session.audience, "Session audience")
  assertNonEmpty(session.tokenHash, "Session token hash")
  assertSessionIdAvailable(db, projectId, sessionId)
}

export function assertSessionIdAvailable(db: Database, projectId: string, sessionId: string): void {
  if (getSessionRowById(db, { projectId, id: sessionId })) {
    throw new AuthStorageError(
      "duplicate_session",
      `[Sixb] Session '${sessionId}' already exists for project '${projectId}'.`
    )
  }
}

export function createSession(
  db: Database,
  input: CreateAuthSessionInput
): ReturnType<typeof rowToSessionRecord> {
  const id = assertNonEmpty(input.id, "Session id")
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
  const audience = assertNonEmpty(input.audience, "Session audience")
  const tokenHash = assertNonEmpty(input.tokenHash, "Session token hash")

  assertSessionIdAvailable(db, projectId, id)

  db.query(
    `
    INSERT INTO auth_sessions (
      project_id,
      id,
      user_id,
      strategy_id,
      audience,
      token_hash,
      created_at,
      expires_at,
      absolute_expires_at,
      user_agent,
      ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    projectId,
    id,
    userId,
    strategyId,
    audience,
    tokenHash,
    toIso(input.createdAt),
    toIso(input.expiresAt),
    input.absoluteExpiresAt ? toIso(input.absoluteExpiresAt) : null,
    input.userAgent ?? null,
    input.ipAddress ?? null
  )

  const session = getSessionById(db, { projectId, id })
  if (!session) {
    throw new AuthStorageError(
      "missing_session",
      `[Sixb] Failed to load session '${id}' for project '${projectId}'.`
    )
  }
  return session
}

export function revokeActiveSessionsForUser(
  db: Database,
  params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: AuthSessionAudience
    readonly revokedAt: Date
  }
): readonly ReturnType<typeof rowToSessionRecord>[] {
  const revokedAt = toIso(params.revokedAt)
  const audienceCondition = params.audience === undefined ? "" : "AND audience = ?"
  const selectArgs =
    params.audience === undefined
      ? [params.projectId, params.userId, revokedAt, revokedAt]
      : [params.projectId, params.userId, params.audience, revokedAt, revokedAt]
  const updateArgs =
    params.audience === undefined
      ? [revokedAt, params.projectId, params.userId, revokedAt, revokedAt]
      : [revokedAt, params.projectId, params.userId, params.audience, revokedAt, revokedAt]
  const rows = db
    .query(
      `
      SELECT *
      FROM auth_sessions
      WHERE project_id = ?
        AND user_id = ?
        ${audienceCondition}
        AND revoked_at IS NULL
        AND expires_at > ?
        AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(...selectArgs) as SqliteAuthSessionRow[]

  db.query(
    `
    UPDATE auth_sessions
    SET revoked_at = ?
    WHERE project_id = ?
      AND user_id = ?
      ${audienceCondition}
      AND revoked_at IS NULL
      AND expires_at > ?
      AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
  `
  ).run(...updateArgs)

  return rows.map((row) =>
    rowToSessionRecord({
      ...row,
      revoked_at: revokedAt,
    })
  )
}

export function upsertGroupMembership(
  db: Database,
  input: UpsertAuthGroupMembershipInput
): GroupMembershipRecord {
  const projectId = assertNonEmpty(input.projectId, "Project id")
  const userId = assertNonEmpty(input.userId, "User id")
  const groupId = assertNonEmpty(input.groupId, "Group id")
  if (!getUserRowById(db, { projectId, id: userId })) {
    throw new AuthStorageError(
      "missing_user",
      `[Sixb] User '${userId}' not found for project '${projectId}'.`
    )
  }

  const existing = getGroupMembership(db, { projectId, userId, groupId })

  if (existing) {
    return existing
  }

  const createdAt = dateOrNow(input.createdAt)
  db.query(
    `
    INSERT INTO auth_group_memberships (
      project_id,
      user_id,
      group_id,
      source,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `
  ).run(projectId, userId, groupId, input.source, toIso(createdAt))

  return {
    projectId,
    userId,
    groupId,
    source: input.source,
    createdAt,
  }
}

export function removeGroupMembership(
  db: Database,
  params: { readonly projectId: string; readonly userId: string; readonly groupId: string }
): GroupMembershipRecord | null {
  const projectId = assertNonEmpty(params.projectId, "Project id")
  const userId = assertNonEmpty(params.userId, "User id")
  const groupId = assertNonEmpty(params.groupId, "Group id")

  const existing = getGroupMembership(db, { projectId, userId, groupId })
  if (!existing) {
    return null
  }

  db.query(
    `
    DELETE FROM auth_group_memberships
    WHERE project_id = ?
      AND user_id = ?
      AND group_id = ?
  `
  ).run(projectId, userId, groupId)

  return existing
}

export function getGroupMembership(
  db: Database,
  params: { readonly projectId: string; readonly userId: string; readonly groupId: string }
): GroupMembershipRecord | null {
  const row = db
    .query(
      `
      SELECT *
      FROM auth_group_memberships
      WHERE project_id = ?
        AND user_id = ?
        AND group_id = ?
    `
    )
    .get(params.projectId, params.userId, params.groupId) as SqliteAuthGroupMembershipRow | null

  return row ? rowToGroupMembershipRecord(row) : null
}

export function listMembershipsForUser(
  db: Database,
  params: { readonly projectId: string; readonly userId: string }
): readonly GroupMembershipRecord[] {
  const rows = db
    .query(
      `
      SELECT *
      FROM auth_group_memberships
      WHERE project_id = ?
        AND user_id = ?
      ORDER BY group_id ASC
    `
    )
    .all(params.projectId, params.userId) as SqliteAuthGroupMembershipRow[]

  return rows.map(rowToGroupMembershipRecord)
}

export function revokeActiveMagicLinksForEmail(
  db: Database,
  params: { readonly projectId: string; readonly email: string; readonly revokedAt: Date }
): readonly MagicLinkRecord[] {
  const email = normalizeEmail(params.email)
  const revokedAt = toIso(params.revokedAt)
  const rows = db
    .query(
      `
      SELECT *
      FROM auth_magic_links
      WHERE project_id = ?
        AND email = ?
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(params.projectId, email, revokedAt) as SqliteAuthMagicLinkRow[]

  db.query(
    `
    UPDATE auth_magic_links
    SET revoked_at = ?
    WHERE project_id = ?
      AND email = ?
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ?
  `
  ).run(revokedAt, params.projectId, email, revokedAt)

  return rows.map((row) =>
    rowToMagicLinkRecord({
      ...row,
      revoked_at: revokedAt,
    })
  )
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
  if (isUniqueConstraintError(error)) {
    throw new AuthStorageError(code, message)
  }

  throw error
}

function invitationRowToRecord(db: Database, row: SqliteAuthInvitationRow): InvitationRecord {
  return rowToInvitationRecord(
    row,
    getInvitationGroupIds(db, {
      projectId: row.project_id,
      invitationId: row.id,
    })
  )
}
