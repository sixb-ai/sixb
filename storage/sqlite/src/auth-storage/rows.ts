import type {
  AccessTokenRecord,
  GroupMembershipRecord,
  GroupMembershipSource,
  InvitationRecord,
  InvitationStatus,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  Principal,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
  ServiceAccountStatus,
  SessionRecord,
  UserIdentityRecord,
  UserRecord,
  UserStatus,
} from "@sixb/core"

export interface SqliteAuthUserRow {
  readonly project_id: string
  readonly id: string
  readonly email: string
  readonly display_name: string | null
  readonly avatar_url: string | null
  readonly status: UserStatus
  readonly created_at: string
  readonly updated_at: string
}

export interface SqliteAuthUserIdentityRow {
  readonly project_id: string
  readonly strategy_id: string
  readonly subject: string
  readonly user_id: string
  readonly claims: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface SqliteAuthServiceAccountRow {
  readonly project_id: string
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly status: ServiceAccountStatus
  readonly created_by_principal_type: Principal["type"] | null
  readonly created_by_principal_id: string | null
  readonly created_by_session_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface SqliteAuthServiceAccountGroupMembershipRow {
  readonly project_id: string
  readonly service_account_id: string
  readonly group_id: string
  readonly source: GroupMembershipSource
  readonly created_at: string
}

export interface SqliteAuthSessionRow {
  readonly project_id: string
  readonly id: string
  readonly user_id: string
  readonly strategy_id: string
  readonly audience: SessionRecord["audience"]
  readonly token_hash: string
  readonly created_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
  readonly last_seen_at: string | null
  readonly user_agent: string | null
  readonly ip_address: string | null
}

export interface SqliteAuthAccessTokenRow {
  readonly project_id: string
  readonly id: string
  readonly name: string
  readonly kind: AccessTokenRecord["kind"]
  readonly subject_type: AccessTokenRecord["subjectType"]
  readonly subject_id: string
  readonly token_hash: string
  readonly group_ids: string | null
  readonly created_by_principal_type: Principal["type"] | null
  readonly created_by_principal_id: string | null
  readonly created_by_session_id: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
  readonly last_used_at: string | null
  readonly last_used_user_agent: string | null
  readonly last_used_ip_address: string | null
}

export interface SqliteAuthInvitationRow {
  readonly project_id: string
  readonly id: string
  readonly email: string
  readonly status: InvitationStatus
  readonly created_by_principal_type: Principal["type"] | null
  readonly created_by_principal_id: string | null
  readonly created_by_session_id: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly expires_at: string
  readonly accepted_at: string | null
  readonly revoked_at: string | null
}

export interface SqliteAuthGroupMembershipRow {
  readonly project_id: string
  readonly user_id: string
  readonly group_id: string
  readonly source: GroupMembershipSource
  readonly created_at: string
}

export interface SqliteAuthMagicLinkRow {
  readonly project_id: string
  readonly id: string
  readonly strategy_id: string
  readonly audience: MagicLinkRecord["audience"]
  readonly email: string
  readonly token_hash: string
  readonly return_to: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly consumed_at: string | null
  readonly revoked_at: string | null
}

export interface SqliteAuthOidcAttemptRow {
  readonly project_id: string
  readonly id: string
  readonly strategy_id: string
  readonly audience: OidcAuthorizationAttemptRecord["audience"]
  readonly state_hash: string
  readonly nonce_hash: string
  readonly code_verifier: string
  readonly return_to: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly consumed_at: string | null
}

export function rowToUserRecord(row: SqliteAuthUserRow): UserRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function rowToIdentityRecord(row: SqliteAuthUserIdentityRow): UserIdentityRecord {
  return {
    projectId: row.project_id,
    strategyId: row.strategy_id,
    subject: row.subject,
    userId: row.user_id,
    claims: parseOptionalRecord(row.claims),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function rowToServiceAccountRecord(row: SqliteAuthServiceAccountRow): ServiceAccountRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    createdByPrincipal:
      row.created_by_principal_type && row.created_by_principal_id
        ? {
            type: row.created_by_principal_type,
            id: row.created_by_principal_id,
          }
        : undefined,
    createdBySessionId: row.created_by_session_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function rowToServiceAccountGroupMembershipRecord(
  row: SqliteAuthServiceAccountGroupMembershipRow
): ServiceAccountGroupMembershipRecord {
  return {
    projectId: row.project_id,
    serviceAccountId: row.service_account_id,
    groupId: row.group_id,
    source: row.source,
    createdAt: new Date(row.created_at),
  }
}

export function rowToSessionRecord(row: SqliteAuthSessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    strategyId: row.strategy_id,
    audience: row.audience,
    tokenHash: row.token_hash,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : undefined,
    userAgent: row.user_agent ?? undefined,
    ipAddress: row.ip_address ?? undefined,
  }
}

export function rowToAccessTokenRecord(row: SqliteAuthAccessTokenRow): AccessTokenRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    tokenHash: row.token_hash,
    groupIds: parseOptionalStringArray(row.group_ids),
    createdByPrincipal:
      row.created_by_principal_type && row.created_by_principal_id
        ? {
            type: row.created_by_principal_type,
            id: row.created_by_principal_id,
          }
        : undefined,
    createdBySessionId: row.created_by_session_id ?? undefined,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    lastUsedUserAgent: row.last_used_user_agent ?? undefined,
    lastUsedIpAddress: row.last_used_ip_address ?? undefined,
  }
}

export function rowToInvitationRecord(
  row: SqliteAuthInvitationRow,
  groupIds: readonly string[]
): InvitationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    groupIds,
    status: row.status,
    createdByPrincipal:
      row.created_by_principal_type && row.created_by_principal_id
        ? {
            type: row.created_by_principal_type,
            id: row.created_by_principal_id,
          }
        : undefined,
    createdBySessionId: row.created_by_session_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
  }
}

export function rowToGroupMembershipRecord(
  row: SqliteAuthGroupMembershipRow
): GroupMembershipRecord {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    groupId: row.group_id,
    source: row.source,
    createdAt: new Date(row.created_at),
  }
}

export function rowToMagicLinkRecord(row: SqliteAuthMagicLinkRow): MagicLinkRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    strategyId: row.strategy_id,
    audience: row.audience,
    email: row.email,
    tokenHash: row.token_hash,
    returnTo: row.return_to ?? undefined,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
  }
}

export function rowToOidcAuthorizationAttemptRecord(
  row: SqliteAuthOidcAttemptRow
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
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : undefined,
  }
}

export function serializeOptionalRecord(
  value: Readonly<Record<string, unknown>> | undefined
): string | null {
  return value ? JSON.stringify(value) : null
}

export function serializeOptionalStringArray(value: readonly string[] | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function parseOptionalRecord(value: string | null): Readonly<Record<string, unknown>> | undefined {
  return value ? (JSON.parse(value) as Readonly<Record<string, unknown>>) : undefined
}

function parseOptionalStringArray(value: string | null): readonly string[] | undefined {
  return value === null ? undefined : (JSON.parse(value) as readonly string[])
}
