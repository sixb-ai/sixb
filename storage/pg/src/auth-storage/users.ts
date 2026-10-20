import type {
  AuthUserStore,
  CreateAuthUserInput,
  ListAuthUsersInput,
  ListAuthUsersResult,
  UpdateAuthUserProfileInput,
  UpdateAuthUserResult,
  UpdateAuthUserStatusInput,
  UserRecord,
} from "@sixb/core/storage"
import { AuthStorageError } from "@sixb/core/storage"
import { type PgStoreClient, runPgTransaction } from "../transactions"
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
  constructor(private readonly sql: PgStoreClient) {}

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

  async getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly UserRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) return []

    const rows = await this.sql<PgAuthUserRow[]>`
      SELECT *
      FROM auth_users
      WHERE project_id = ${params.projectId}
        AND id IN ${this.sql(ids)}
    `

    return rows.map(rowToUserRecord)
  }

  async getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null> {
    const row = await getUserRowByEmail(this.sql, params)
    return row ? rowToUserRecord(row) : null
  }

  async updateProfile(input: UpdateAuthUserProfileInput): Promise<UpdateAuthUserResult> {
    // The row stays locked until the update, so the user it returns as previous is the one it
    // changed, and an omitted field keeps whatever a concurrent update wrote to it.
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await getUserRowById(
        tx,
        {
          projectId: input.projectId,
          id: input.id,
        },
        { forUpdate: true }
      )

      if (!existing) {
        throw new AuthStorageError(
          "missing_user",
          `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const previousUser = rowToUserRecord(existing)
      if (!changesProfile(previousUser, input)) {
        return { user: previousUser, previousUser }
      }

      const updatedAt = dateOrNow(input.updatedAt)
      const [row] = await tx<PgAuthUserRow[]>`
        UPDATE auth_users
        SET display_name = CASE
              WHEN ${input.displayName !== undefined}::boolean THEN ${input.displayName ?? null}::text
              ELSE display_name
            END,
            avatar_url = CASE
              WHEN ${input.avatarUrl !== undefined}::boolean THEN ${input.avatarUrl ?? null}::text
              ELSE avatar_url
            END,
            updated_at = ${updatedAt}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
        RETURNING *
      `

      return { user: rowToUserRecord(row), previousUser }
    })
  }

  async updateStatus(input: UpdateAuthUserStatusInput): Promise<UpdateAuthUserResult> {
    // Locked like a profile update, so two status changes cannot both report the same previous one.
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await getUserRowById(
        tx,
        {
          projectId: input.projectId,
          id: input.id,
        },
        { forUpdate: true }
      )

      if (!existing) {
        throw new AuthStorageError(
          "missing_user",
          `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const updatedAt = dateOrNow(input.updatedAt)
      const [row] = await tx<PgAuthUserRow[]>`
        UPDATE auth_users
        SET status = ${input.status},
            updated_at = ${updatedAt}
        WHERE project_id = ${input.projectId}
          AND id = ${input.id}
        RETURNING *
      `

      return { user: rowToUserRecord(row), previousUser: rowToUserRecord(existing) }
    })
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

    // `strpos` matches literally, so `%` and `_` need no escaping. Both sides fold through `lower()`.
    if (input.search !== undefined) {
      const index = nextIndex++
      whereClauses.push(
        `(strpos(lower(coalesce(display_name, '')), lower($${index})) > 0 OR strpos(lower(email), lower($${index})) > 0)`
      )
      params.push(input.search)
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

// Omitted keeps the stored value, and `null` clears it.
function changesProfile(user: UserRecord, input: UpdateAuthUserProfileInput): boolean {
  const displayName =
    input.displayName === undefined ? user.displayName : (input.displayName ?? undefined)
  const avatarUrl = input.avatarUrl === undefined ? user.avatarUrl : (input.avatarUrl ?? undefined)

  return displayName !== user.displayName || avatarUrl !== user.avatarUrl
}
