import type {
  AuthUserStore,
  CreateAuthUserInput,
  ListAuthUsersInput,
  ListAuthUsersResult,
  UpdateAuthUserProfileInput,
  UpdateAuthUserStatusInput,
  UserRecord,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SQL } from "../pg-client"
import type { PgAuthUserRow } from "./rows"
import { rowToUserRecord } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  dateOrNow,
  getUserRowByEmail,
  getUserRowById,
  hasEmptyFilter,
  mapUniqueConstraintError,
  normalizeEmail,
  type PgValue,
} from "./shared"

export class PgAuthUserStore implements AuthUserStore {
  constructor(private readonly sql: SQL) {}

  async create(input: CreateAuthUserInput): Promise<UserRecord> {
    const id = assertNonEmpty(input.id, "User id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const email = normalizeEmail(input.email)

    if (await getUserRowById(this.sql, { projectId, id })) {
      throw new AuthStorageError(
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }

    if (await getUserRowByEmail(this.sql, { projectId, email })) {
      throw new AuthStorageError(
        "duplicate_user",
        `[Sixb] User email '${email}' already exists for project '${projectId}'.`
      )
    }

    const createdAt = dateOrNow(input.createdAt)
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : createdAt

    try {
      const [row] = await this.sql<PgAuthUserRow[]>`
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
          ${projectId},
          ${id},
          ${email},
          ${input.displayName ?? null},
          ${input.avatarUrl ?? null},
          ${input.status ?? "active"},
          ${createdAt},
          ${updatedAt}
        )
        RETURNING *
      `

      return rowToUserRecord(row)
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<UserRecord | null> {
    const row = await getUserRowById(this.sql, params)
    return row ? rowToUserRecord(row) : null
  }

  async getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null> {
    const row = await getUserRowByEmail(this.sql, params)
    return row ? rowToUserRecord(row) : null
  }

  async updateProfile(input: UpdateAuthUserProfileInput): Promise<UserRecord> {
    const existing = await getUserRowById(this.sql, {
      projectId: input.projectId,
      id: input.id,
    })

    if (!existing) {
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const updatedAt = dateOrNow(input.updatedAt)
    const [row] = await this.sql<PgAuthUserRow[]>`
      UPDATE auth_users
      SET display_name = ${input.displayName ?? null},
          avatar_url = ${input.avatarUrl ?? null},
          updated_at = ${updatedAt}
      WHERE project_id = ${input.projectId}
        AND id = ${input.id}
      RETURNING *
    `

    return rowToUserRecord(row)
  }

  async updateStatus(input: UpdateAuthUserStatusInput): Promise<UserRecord> {
    const existing = await getUserRowById(this.sql, {
      projectId: input.projectId,
      id: input.id,
    })

    if (!existing) {
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const updatedAt = dateOrNow(input.updatedAt)
    const [row] = await this.sql<PgAuthUserRow[]>`
      UPDATE auth_users
      SET status = ${input.status},
          updated_at = ${updatedAt}
      WHERE project_id = ${input.projectId}
        AND id = ${input.id}
      RETURNING *
    `

    return rowToUserRecord(row)
  }

  async list(input: ListAuthUsersInput): Promise<ListAuthUsersResult> {
    if (hasEmptyFilter(input.statuses)) {
      return { users: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: PgValue[] = [input.projectId]
    let nextIndex = 2

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => `$${nextIndex++}`).join(", ")})`)
      params.push(...input.statuses)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const [totalRow] = await this.sql.unsafe<{ readonly count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM auth_users ${where}`,
      [...params]
    )

    const queryParams = [...params]
    const query = appendPagination(
      `
        SELECT *
        FROM auth_users
        ${where}
        ORDER BY created_at ${order}, id ${order}
      `,
      queryParams,
      nextIndex,
      input
    )
    const rows = await this.sql.unsafe<PgAuthUserRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)

    return {
      users: rows.map(rowToUserRecord),
      hasMore: (input.offset ?? 0) + rows.length < total,
      total,
    }
  }
}
