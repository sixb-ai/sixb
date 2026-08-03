import type { Database } from "bun:sqlite"
import type {
  AccessTokenRecord,
  AuthAccessTokenStore,
  CreateAuthAccessTokenInput,
  ListAuthAccessTokensInput,
  ListAuthAccessTokensResult,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import type {
  SqliteAuthAccessTokenRow,
  SqliteAuthServiceAccountRow,
  SqliteAuthUserRow,
} from "./rows"
import { rowToAccessTokenRecord, serializeOptionalStringArray } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  mapUniqueConstraintError,
  normalizeGroupIds,
  type SqliteValue,
  toIso,
} from "./shared"

export class SqliteAuthAccessTokenStore implements AuthAccessTokenStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthAccessTokenInput): Promise<AccessTokenRecord> {
    const id = assertNonEmpty(input.id, "Access token id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const name = assertNonEmpty(input.name, "Access token name")
    const subjectId = assertNonEmpty(input.subjectId, "Access token subject id")
    const tokenHash = assertNonEmpty(input.tokenHash, "Access token hash")
    assertKindMatchesSubject(input)
    this.assertSubjectExists(projectId, input.subjectType, subjectId)
    const groupIds = input.groupIds === undefined ? undefined : normalizeGroupIds(input.groupIds)

    try {
      this.db
        .query(
          `
          INSERT INTO auth_access_tokens (
            project_id,
            id,
            name,
            kind,
            subject_type,
            subject_id,
            token_hash,
            group_ids,
            created_by_principal_type,
            created_by_principal_id,
            created_by_session_id,
            created_at,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          projectId,
          id,
          name,
          input.kind,
          input.subjectType,
          subjectId,
          tokenHash,
          serializeOptionalStringArray(groupIds),
          input.createdByPrincipal?.type ?? null,
          input.createdByPrincipal?.id ?? null,
          input.createdBySessionId ?? null,
          toIso(input.createdAt),
          toIso(input.expiresAt)
        )
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_access_token",
        `[Sixb] Access token '${id}' already exists for project '${projectId}'.`
      )
    }

    const token = await this.getById({ projectId, id })
    if (!token) {
      throw authStorageError(
        "missing_access_token",
        `[Sixb] Access token '${id}' not found for project '${projectId}'.`
      )
    }
    return token
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AccessTokenRecord | null> {
    const row = this.db
      .query("SELECT * FROM auth_access_tokens WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as SqliteAuthAccessTokenRow | null
    return row ? rowToAccessTokenRecord(row) : null
  }

  async list(input: ListAuthAccessTokensInput): Promise<ListAuthAccessTokensResult> {
    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]
    if (input.kind) {
      whereClauses.push("kind = ?")
      args.push(input.kind)
    }
    if (input.subjectType) {
      whereClauses.push("subject_type = ?")
      args.push(input.subjectType)
    }
    if (input.subjectId) {
      whereClauses.push("subject_id = ?")
      args.push(input.subjectId)
    }
    if (!input.includeRevoked) {
      whereClauses.push("revoked_at IS NULL")
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "desc" ? "DESC" : "ASC"
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM auth_access_tokens ${where}`)
      .get(...args) as { readonly count: number }
    const queryArgs = [...args]
    const query = appendPagination(
      `
      SELECT *
      FROM auth_access_tokens
      ${where}
      ORDER BY created_at ${order}, id ${order}
    `,
      queryArgs,
      input
    )
    const rows = this.db.query(query).all(...queryArgs) as SqliteAuthAccessTokenRow[]

    return {
      accessTokens: rows.map(rowToAccessTokenRecord),
      hasMore:
        input.limit === undefined ? false : (input.offset ?? 0) + input.limit < totalRow.count,
      total: totalRow.count,
    }
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly kind: AccessTokenRecord["kind"]
    readonly tokenHash: string
    readonly now: Date
  }): Promise<AccessTokenRecord | null> {
    const row = this.db
      .query(
        `
        SELECT *
        FROM auth_access_tokens
        WHERE project_id = ?
          AND id = ?
          AND kind = ?
          AND token_hash = ?
          AND revoked_at IS NULL
          AND expires_at > ?
      `
      )
      .get(
        params.projectId,
        params.id,
        params.kind,
        params.tokenHash,
        toIso(params.now)
      ) as SqliteAuthAccessTokenRow | null

    return row ? rowToAccessTokenRecord(row) : null
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<AccessTokenRecord> {
    const existing = await this.getById(params)
    if (!existing) {
      throw authStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    this.db
      .query(
        `
        UPDATE auth_access_tokens
        SET revoked_at = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(toIso(params.revokedAt), params.projectId, params.id)

    return { ...existing, revokedAt: new Date(params.revokedAt) }
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastUsedAt: Date
    readonly userAgent?: string
    readonly ipAddress?: string
  }): Promise<AccessTokenRecord> {
    const existing = await this.getById(params)
    if (!existing) {
      throw authStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const lastUsedUserAgent = params.userAgent ?? existing.lastUsedUserAgent
    const lastUsedIpAddress = params.ipAddress ?? existing.lastUsedIpAddress

    this.db
      .query(
        `
        UPDATE auth_access_tokens
        SET last_used_at = ?,
            last_used_user_agent = ?,
            last_used_ip_address = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(
        toIso(params.lastUsedAt),
        lastUsedUserAgent ?? null,
        lastUsedIpAddress ?? null,
        params.projectId,
        params.id
      )

    return {
      ...existing,
      lastUsedAt: new Date(params.lastUsedAt),
      lastUsedUserAgent,
      lastUsedIpAddress,
    }
  }

  private assertSubjectExists(
    projectId: string,
    subjectType: CreateAuthAccessTokenInput["subjectType"],
    subjectId: string
  ): void {
    if (subjectType === "user") {
      const row = this.db
        .query("SELECT * FROM auth_users WHERE project_id = ? AND id = ?")
        .get(projectId, subjectId) as SqliteAuthUserRow | null
      if (row) return
      throw authStorageError(
        "missing_user",
        `[Sixb] User '${subjectId}' not found for project '${projectId}'.`
      )
    }

    const row = this.db
      .query("SELECT * FROM auth_service_accounts WHERE project_id = ? AND id = ?")
      .get(projectId, subjectId) as SqliteAuthServiceAccountRow | null
    if (row) return
    throw authStorageError(
      "missing_service_account",
      `[Sixb] Service account '${subjectId}' not found for project '${projectId}'.`
    )
  }
}

function assertKindMatchesSubject(input: CreateAuthAccessTokenInput): void {
  if (
    (input.kind === "personal" && input.subjectType === "user") ||
    (input.kind === "serviceAccount" && input.subjectType === "serviceAccount")
  ) {
    return
  }

  throw authStorageError(
    "invalid_input",
    `[Sixb] Access token kind '${input.kind}' cannot target subject type '${input.subjectType}'.`
  )
}
