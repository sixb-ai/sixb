import type { Database } from "bun:sqlite"
import type {
  AuthUserStore,
  CreateAuthUserInput,
  ListAuthUsersInput,
  ListAuthUsersResult,
  UpdateAuthUserProfileInput,
  UpdateAuthUserStatusInput,
  UserRecord,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import type { SqliteAuthUserRow } from "./rows"
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
  type SqliteValue,
  toIso,
} from "./shared"

export class SqliteAuthUserStore implements AuthUserStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthUserInput): Promise<UserRecord> {
    const id = assertNonEmpty(input.id, "User id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const email = normalizeEmail(input.email)

    if (getUserRowById(this.db, { projectId, id })) {
      throw authStorageError(
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }

    if (getUserRowByEmail(this.db, { projectId, email })) {
      throw authStorageError(
        "duplicate_user",
        `[Sixb] User email '${email}' already exists for project '${projectId}'.`
      )
    }

    const createdAt = dateOrNow(input.createdAt)
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : createdAt

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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          projectId,
          id,
          email,
          input.displayName ?? null,
          input.avatarUrl ?? null,
          input.status ?? "active",
          toIso(createdAt),
          toIso(updatedAt)
        )
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }

    return {
      id,
      projectId,
      email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: input.status ?? "active",
      createdAt,
      updatedAt,
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<UserRecord | null> {
    const row = getUserRowById(this.db, params)
    return row ? rowToUserRecord(row) : null
  }

  async getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null> {
    const row = getUserRowByEmail(this.db, params)
    return row ? rowToUserRecord(row) : null
  }

  async updateProfile(input: UpdateAuthUserProfileInput): Promise<UserRecord> {
    const existing = getUserRowById(this.db, {
      projectId: input.projectId,
      id: input.id,
    })

    if (!existing) {
      throw authStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const updatedAt = dateOrNow(input.updatedAt)
    this.db
      .query(
        `
        UPDATE auth_users
        SET display_name = ?,
            avatar_url = ?,
            updated_at = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(
        input.displayName ?? null,
        input.avatarUrl ?? null,
        toIso(updatedAt),
        input.projectId,
        input.id
      )

    return rowToUserRecord({
      ...existing,
      display_name: input.displayName ?? null,
      avatar_url: input.avatarUrl ?? null,
      updated_at: toIso(updatedAt),
    })
  }

  async updateStatus(input: UpdateAuthUserStatusInput): Promise<UserRecord> {
    const existing = getUserRowById(this.db, {
      projectId: input.projectId,
      id: input.id,
    })

    if (!existing) {
      throw authStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const updatedAt = dateOrNow(input.updatedAt)
    this.db
      .query(
        `
        UPDATE auth_users
        SET status = ?,
            updated_at = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(input.status, toIso(updatedAt), input.projectId, input.id)

    return rowToUserRecord({
      ...existing,
      status: input.status,
      updated_at: toIso(updatedAt),
    })
  }

  async list(input: ListAuthUsersInput): Promise<ListAuthUsersResult> {
    if (hasEmptyFilter(input.statuses)) {
      return { users: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM auth_users ${where}`)
      .get(...args) as { readonly count: number }

    const queryArgs = [...args]
    const query = appendPagination(
      `
      SELECT *
      FROM auth_users
      ${where}
      ORDER BY created_at ${order}, id ${order}
    `,
      queryArgs,
      input
    )
    const rows = this.db.query(query).all(...queryArgs) as SqliteAuthUserRow[]

    return {
      users: rows.map(rowToUserRecord),
      hasMore: (input.offset ?? 0) + rows.length < totalRow.count,
      total: totalRow.count,
    }
  }
}
