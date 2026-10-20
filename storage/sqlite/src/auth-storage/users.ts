import type { Database } from "bun:sqlite"
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
import { runImmediateTransaction } from "../transactions"
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
      throw new AuthStorageError(
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }

    if (getUserRowByEmail(this.db, { projectId, email })) {
      throw new AuthStorageError(
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

  async getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly UserRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) return []

    const rows = this.db
      .query(
        `SELECT * FROM auth_users WHERE project_id = ? AND id IN (${ids.map(() => "?").join(", ")})`
      )
      .all(params.projectId, ...ids) as SqliteAuthUserRow[]

    return rows.map(rowToUserRecord)
  }

  async getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null> {
    const row = getUserRowByEmail(this.db, params)
    return row ? rowToUserRecord(row) : null
  }

  async updateProfile(input: UpdateAuthUserProfileInput): Promise<UpdateAuthUserResult> {
    // One transaction, so the user it returns as previous is the one it changed.
    return runImmediateTransaction(this.db, () => {
      const existing = getUserRowById(this.db, {
        projectId: input.projectId,
        id: input.id,
      })

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
      const row = this.db
        .query(
          `
          UPDATE auth_users
          SET display_name = CASE WHEN ? THEN ? ELSE display_name END,
              avatar_url = CASE WHEN ? THEN ? ELSE avatar_url END,
              updated_at = ?
          WHERE project_id = ?
            AND id = ?
          RETURNING *
        `
        )
        .get(
          input.displayName === undefined ? 0 : 1,
          input.displayName ?? null,
          input.avatarUrl === undefined ? 0 : 1,
          input.avatarUrl ?? null,
          toIso(updatedAt),
          input.projectId,
          input.id
        ) as SqliteAuthUserRow

      return { user: rowToUserRecord(row), previousUser }
    })
  }

  async updateStatus(input: UpdateAuthUserStatusInput): Promise<UpdateAuthUserResult> {
    // One transaction, so two status changes cannot both report the same previous one.
    return runImmediateTransaction(this.db, () => {
      const existing = getUserRowById(this.db, {
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

      const user = rowToUserRecord({
        ...existing,
        status: input.status,
        updated_at: toIso(updatedAt),
      })
      return { user, previousUser: rowToUserRecord(existing) }
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

    // `instr` matches literally, so `%` and `_` need no escaping. Both sides fold through the same
    // `lower()`, which ignores case for ASCII letters only: "émilie" does not find "Émilie" here.
    if (input.search !== undefined) {
      whereClauses.push(
        "(instr(lower(coalesce(display_name, '')), lower(?)) > 0 OR instr(lower(email), lower(?)) > 0)"
      )
      args.push(input.search, input.search)
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

// Omitted keeps the stored value, and `null` clears it.
function changesProfile(user: UserRecord, input: UpdateAuthUserProfileInput): boolean {
  const displayName =
    input.displayName === undefined ? user.displayName : (input.displayName ?? undefined)
  const avatarUrl = input.avatarUrl === undefined ? user.avatarUrl : (input.avatarUrl ?? undefined)

  return displayName !== user.displayName || avatarUrl !== user.avatarUrl
}
