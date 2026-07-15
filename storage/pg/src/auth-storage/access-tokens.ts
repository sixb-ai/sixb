import type {
  AccessTokenRecord,
  AuthAccessTokenStore,
  CreateAuthAccessTokenInput,
  ListAuthAccessTokensInput,
  ListAuthAccessTokensResult,
} from "@sixb/core/storage"
import { AuthStorageError } from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import type { PgAuthAccessTokenRow, PgAuthServiceAccountRow, PgAuthUserRow } from "./rows"
import { rowToAccessTokenRecord, serializeOptionalStringArray } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  mapUniqueConstraintError,
  normalizeGroupIds,
  type PgValue,
} from "./shared"

export class PgAuthAccessTokenStore implements AuthAccessTokenStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateAuthAccessTokenInput): Promise<AccessTokenRecord> {
    const id = assertNonEmpty(input.id, "Access token id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const name = assertNonEmpty(input.name, "Access token name")
    const subjectId = assertNonEmpty(input.subjectId, "Access token subject id")
    const tokenHash = assertNonEmpty(input.tokenHash, "Access token hash")
    assertKindMatchesSubject(input)
    await this.assertSubjectExists(projectId, input.subjectType, subjectId)
    const groupIds = input.groupIds === undefined ? undefined : normalizeGroupIds(input.groupIds)

    try {
      const [row] = await this.sql<PgAuthAccessTokenRow[]>`
        INSERT INTO auth_access_tokens (
          project_id,
          id,
          name,
          kind,
          subject_type,
          subject_id,
          token_hash,
          group_ids,
          created_by_user_id,
          created_by_service_account_id,
          created_by_system_id,
          created_by_session_id,
          created_at,
          expires_at
        ) VALUES (
          ${projectId},
          ${id},
          ${name},
          ${input.kind},
          ${input.subjectType},
          ${subjectId},
          ${tokenHash},
          ${serializeOptionalStringArray(groupIds)},
          ${input.createdByPrincipal?.type === "user" ? input.createdByPrincipal.id : null},
          ${
            input.createdByPrincipal?.type === "serviceAccount" ? input.createdByPrincipal.id : null
          },
          ${input.createdByPrincipal?.type === "system" ? input.createdByPrincipal.id : null},
          ${input.createdBySessionId ?? null},
          ${input.createdAt},
          ${input.expiresAt}
        )
        RETURNING *
      `

      return rowToAccessTokenRecord(row)
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_access_token",
        `[Sixb] Access token '${id}' already exists for project '${projectId}'.`
      )
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AccessTokenRecord | null> {
    const [row] = await this.sql<PgAuthAccessTokenRow[]>`
      SELECT *
      FROM auth_access_tokens
      WHERE project_id = ${params.projectId}
        AND id = ${params.id}
    `
    return row ? rowToAccessTokenRecord(row) : null
  }

  async list(input: ListAuthAccessTokensInput): Promise<ListAuthAccessTokensResult> {
    const whereClauses = ["project_id = $1"]
    const params: PgValue[] = [input.projectId]
    let nextIndex = 2
    if (input.kind) {
      whereClauses.push(`kind = $${nextIndex++}`)
      params.push(input.kind)
    }
    if (input.subjectType) {
      whereClauses.push(`subject_type = $${nextIndex++}`)
      params.push(input.subjectType)
    }
    if (input.subjectId) {
      whereClauses.push(`subject_id = $${nextIndex++}`)
      params.push(input.subjectId)
    }
    if (!input.includeRevoked) {
      whereClauses.push("revoked_at IS NULL")
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "desc" ? "DESC" : "ASC"
    const [totalRow] = await this.sql.unsafe<{ readonly count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM auth_access_tokens ${where}`,
      [...params]
    )
    const queryParams = [...params]
    const query = appendPagination(
      `
        SELECT *
        FROM auth_access_tokens
        ${where}
        ORDER BY created_at ${order}, id ${order}
      `,
      queryParams,
      nextIndex,
      input
    )
    const rows = await this.sql.unsafe<PgAuthAccessTokenRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)

    return {
      accessTokens: rows.map(rowToAccessTokenRecord),
      hasMore: input.limit === undefined ? false : (input.offset ?? 0) + input.limit < total,
      total,
    }
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly kind: AccessTokenRecord["kind"]
    readonly tokenHash: string
    readonly now: Date
  }): Promise<AccessTokenRecord | null> {
    const [row] = await this.sql<PgAuthAccessTokenRow[]>`
      SELECT *
      FROM auth_access_tokens
      WHERE project_id = ${params.projectId}
        AND id = ${params.id}
        AND kind = ${params.kind}
        AND token_hash = ${params.tokenHash}
        AND revoked_at IS NULL
        AND expires_at > ${params.now}
    `

    return row ? rowToAccessTokenRecord(row) : null
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<AccessTokenRecord> {
    const [row] = await this.sql<PgAuthAccessTokenRow[]>`
      UPDATE auth_access_tokens
      SET revoked_at = ${params.revokedAt}
      WHERE project_id = ${params.projectId}
        AND id = ${params.id}
      RETURNING *
    `
    if (!row) {
      throw new AuthStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }
    return rowToAccessTokenRecord(row)
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastUsedAt: Date
    readonly userAgent?: string
    readonly ipAddress?: string
  }): Promise<AccessTokenRecord> {
    const [row] = await this.sql<PgAuthAccessTokenRow[]>`
      UPDATE auth_access_tokens
      SET last_used_at = ${params.lastUsedAt},
          last_used_user_agent = COALESCE(${params.userAgent ?? null}, last_used_user_agent),
          last_used_ip_address = COALESCE(${params.ipAddress ?? null}, last_used_ip_address)
      WHERE project_id = ${params.projectId}
        AND id = ${params.id}
      RETURNING *
    `
    if (!row) {
      throw new AuthStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }
    return rowToAccessTokenRecord(row)
  }

  private async assertSubjectExists(
    projectId: string,
    subjectType: CreateAuthAccessTokenInput["subjectType"],
    subjectId: string
  ): Promise<void> {
    if (subjectType === "user") {
      const [row] = await this.sql<PgAuthUserRow[]>`
        SELECT *
        FROM auth_users
        WHERE project_id = ${projectId}
          AND id = ${subjectId}
      `
      if (row) return
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${subjectId}' not found for project '${projectId}'.`
      )
    }

    const [row] = await this.sql<PgAuthServiceAccountRow[]>`
      SELECT *
      FROM auth_service_accounts
      WHERE project_id = ${projectId}
        AND id = ${subjectId}
    `
    if (row) return
    throw new AuthStorageError(
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

  throw new AuthStorageError(
    "invalid_input",
    `[Sixb] Access token kind '${input.kind}' cannot target subject type '${input.subjectType}'.`
  )
}
