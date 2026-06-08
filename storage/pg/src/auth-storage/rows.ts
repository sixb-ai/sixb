import type {
  GroupMembershipRecord,
  GroupMembershipSource,
  InvitationRecord,
  InvitationStatus,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  Principal,
  SessionRecord,
  UserIdentityRecord,
  UserRecord,
  UserStatus,
} from "@sixb/core"

type PgDate = Date | string

export interface PgAuthUserRow {
  readonly project_id: string
  readonly id: string
  readonly email: string
  readonly display_name: string | null
  readonly avatar_url: string | null
  readonly status: UserStatus
  readonly created_at: PgDate
  readonly updated_at: PgDate
}

export interface PgAuthUserIdentityRow {
  readonly project_id: string
  readonly strategy_id: string
  readonly subject: string
  readonly user_id: string
  readonly claims: Readonly<Record<string, unknown>> | string | null
  readonly created_at: PgDate
  readonly updated_at: PgDate
}

export interface PgAuthSessionRow {
  readonly project_id: string
  readonly id: string
  readonly user_id: string
  readonly strategy_id: string
  readonly audience: SessionRecord["audience"]
  readonly token_hash: string
  readonly created_at: PgDate
  readonly expires_at: PgDate
  readonly revoked_at: PgDate | null
  readonly last_seen_at: PgDate | null
  readonly user_agent: string | null
  readonly ip_address: string | null
}

export interface PgAuthInvitationRow {
  readonly project_id: string
  readonly id: string
  readonly email: string
  readonly status: InvitationStatus
  readonly created_by_user_id: string | null
  readonly created_by_service_account_id: string | null
  readonly created_by_system_id: string | null
  readonly created_by_session_id: string | null
  readonly created_at: PgDate
  readonly updated_at: PgDate
  readonly expires_at: PgDate
  readonly accepted_at: PgDate | null
  readonly revoked_at: PgDate | null
}

export interface PgAuthGroupMembershipRow {
  readonly project_id: string
  readonly user_id: string
  readonly group_id: string
  readonly source: GroupMembershipSource
  readonly created_at: PgDate
}

export interface PgAuthMagicLinkRow {
  readonly project_id: string
  readonly id: string
  readonly strategy_id: string
  readonly audience: MagicLinkRecord["audience"]
  readonly email: string
  readonly token_hash: string
  readonly return_to: string | null
  readonly created_at: PgDate
  readonly expires_at: PgDate
  readonly consumed_at: PgDate | null
  readonly revoked_at: PgDate | null
}

export interface PgAuthOidcAttemptRow {
  readonly project_id: string
  readonly id: string
  readonly strategy_id: string
  readonly audience: OidcAuthorizationAttemptRecord["audience"]
  readonly state_hash: string
  readonly nonce_hash: string
  readonly code_verifier: string
  readonly return_to: string | null
  readonly created_at: PgDate
  readonly expires_at: PgDate
  readonly consumed_at: PgDate | null
}

export function rowToUserRecord(row: PgAuthUserRow): UserRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

export function rowToIdentityRecord(row: PgAuthUserIdentityRow): UserIdentityRecord {
  return {
    projectId: row.project_id,
    strategyId: row.strategy_id,
    subject: row.subject,
    userId: row.user_id,
    claims: parseOptionalRecord(row.claims),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

export function rowToSessionRecord(row: PgAuthSessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    strategyId: row.strategy_id,
    audience: row.audience,
    tokenHash: row.token_hash,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : undefined,
    lastSeenAt: row.last_seen_at ? toDate(row.last_seen_at) : undefined,
    userAgent: row.user_agent ?? undefined,
    ipAddress: row.ip_address ?? undefined,
  }
}

export function rowToInvitationRecord(
  row: PgAuthInvitationRow,
  groupIds: readonly string[]
): InvitationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    groupIds,
    status: row.status,
    createdByPrincipal: invitationCreatorFromRow(row),
    createdBySessionId: row.created_by_session_id ?? undefined,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    expiresAt: toDate(row.expires_at),
    acceptedAt: row.accepted_at ? toDate(row.accepted_at) : undefined,
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : undefined,
  }
}

export function rowToGroupMembershipRecord(row: PgAuthGroupMembershipRow): GroupMembershipRecord {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    groupId: row.group_id,
    source: row.source,
    createdAt: toDate(row.created_at),
  }
}

export function rowToMagicLinkRecord(row: PgAuthMagicLinkRow): MagicLinkRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    strategyId: row.strategy_id,
    audience: row.audience,
    email: row.email,
    tokenHash: row.token_hash,
    returnTo: row.return_to ?? undefined,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    consumedAt: row.consumed_at ? toDate(row.consumed_at) : undefined,
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : undefined,
  }
}

export function rowToOidcAuthorizationAttemptRecord(
  row: PgAuthOidcAttemptRow
): OidcAuthorizationAttemptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    strategyId: row.strategy_id,
    audience: row.audience,
    stateHash: row.state_hash,
    nonceHash: row.nonce_hash,
    codeVerifier: row.code_verifier,
    returnTo: row.return_to ?? undefined,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    consumedAt: row.consumed_at ? toDate(row.consumed_at) : undefined,
  }
}

export function serializeOptionalRecord(
  value: Readonly<Record<string, unknown>> | undefined
): string | null {
  return value ? JSON.stringify(value) : null
}

function invitationCreatorFromRow(row: PgAuthInvitationRow): Principal | undefined {
  if (row.created_by_user_id) return { type: "user", id: row.created_by_user_id }
  if (row.created_by_service_account_id) {
    return { type: "serviceAccount", id: row.created_by_service_account_id }
  }
  if (row.created_by_system_id) return { type: "system", id: row.created_by_system_id }
  return undefined
}

function parseOptionalRecord(
  value: Readonly<Record<string, unknown>> | string | null
): Readonly<Record<string, unknown>> | undefined {
  if (!value) return undefined
  if (typeof value === "string") return JSON.parse(value) as Readonly<Record<string, unknown>>
  return structuredClone(value)
}

function toDate(value: PgDate): Date {
  return value instanceof Date ? new Date(value) : new Date(value)
}
