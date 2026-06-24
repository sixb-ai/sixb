import type { Database } from "bun:sqlite"
import type {
  AuthServiceAccountStore,
  CreateAuthServiceAccountInput,
  ListAuthServiceAccountsInput,
  ListAuthServiceAccountsResult,
  ServiceAccountRecord,
  UpdateAuthServiceAccountInput,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SqliteAuthServiceAccountRow } from "./rows"
import { rowToServiceAccountRecord } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  dateOrNow,
  hasEmptyFilter,
  mapUniqueConstraintError,
  type SqliteValue,
  toIso,
} from "./shared"

export class SqliteAuthServiceAccountStore implements AuthServiceAccountStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthServiceAccountInput): Promise<ServiceAccountRecord> {
    const id = assertNonEmpty(input.id, "Service account id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const name = assertNonEmpty(input.name, "Service account name")
    const createdAt = dateOrNow(input.createdAt)
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : createdAt

    try {
      this.db
        .query(
          `
          INSERT INTO auth_service_accounts (
            project_id,
            id,
            name,
            description,
            status,
            created_by_principal_type,
            created_by_principal_id,
            created_by_session_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          projectId,
          id,
          name,
          input.description ?? null,
          input.status ?? "active",
          input.createdByPrincipal?.type ?? null,
          input.createdByPrincipal?.id ?? null,
          input.createdBySessionId ?? null,
          toIso(createdAt),
          toIso(updatedAt)
        )
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_service_account",
        `[Sixb] Service account '${id}' already exists for project '${projectId}'.`
      )
    }

    return {
      id,
      projectId,
      name,
      description: input.description,
      status: input.status ?? "active",
      createdByPrincipal: input.createdByPrincipal,
      createdBySessionId: input.createdBySessionId,
      createdAt,
      updatedAt,
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ServiceAccountRecord | null> {
    const row = this.db
      .query("SELECT * FROM auth_service_accounts WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as SqliteAuthServiceAccountRow | null
    return row ? rowToServiceAccountRecord(row) : null
  }

  async update(input: UpdateAuthServiceAccountInput): Promise<ServiceAccountRecord> {
    const existing = await this.getById(input)
    if (!existing) {
      throw new AuthStorageError(
        "missing_service_account",
        `[Sixb] Service account '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const updatedAt = dateOrNow(input.updatedAt)
    const name =
      input.name === undefined ? existing.name : assertNonEmpty(input.name, "Service account name")
    const description = input.description === undefined ? existing.description : input.description
    const status = input.status ?? existing.status
    this.db
      .query(
        `
        UPDATE auth_service_accounts
        SET name = ?,
            description = ?,
            status = ?,
            updated_at = ?
        WHERE project_id = ?
          AND id = ?
      `
      )
      .run(name, description ?? null, status, toIso(updatedAt), input.projectId, input.id)

    return {
      ...existing,
      name,
      description,
      status,
      updatedAt,
    }
  }

  async list(input: ListAuthServiceAccountsInput): Promise<ListAuthServiceAccountsResult> {
    if (hasEmptyFilter(input.statuses)) {
      return { serviceAccounts: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]
    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "desc" ? "DESC" : "ASC"
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM auth_service_accounts ${where}`)
      .get(...args) as { readonly count: number }
    const queryArgs = [...args]
    const query = appendPagination(
      `
      SELECT *
      FROM auth_service_accounts
      ${where}
      ORDER BY created_at ${order}, id ${order}
    `,
      queryArgs,
      input
    )
    const rows = this.db.query(query).all(...queryArgs) as SqliteAuthServiceAccountRow[]

    return {
      serviceAccounts: rows.map(rowToServiceAccountRecord),
      hasMore:
        input.limit === undefined ? false : (input.offset ?? 0) + input.limit < totalRow.count,
      total: totalRow.count,
    }
  }
}
