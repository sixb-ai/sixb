import type {
  AuthServiceAccountStore,
  CreateAuthServiceAccountInput,
  ListAuthServiceAccountsInput,
  ListAuthServiceAccountsResult,
  ServiceAccountRecord,
  UpdateAuthServiceAccountInput,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { PgStoreClient } from "../transactions"
import type { PgAuthServiceAccountRow } from "./rows"
import { rowToServiceAccountRecord } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  dateOrNow,
  hasEmptyFilter,
  mapUniqueConstraintError,
  type PgValue,
} from "./shared"

export class PgAuthServiceAccountStore implements AuthServiceAccountStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateAuthServiceAccountInput): Promise<ServiceAccountRecord> {
    const id = assertNonEmpty(input.id, "Service account id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const name = assertNonEmpty(input.name, "Service account name")
    const createdAt = dateOrNow(input.createdAt)
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : createdAt

    try {
      const [row] = await this.sql<PgAuthServiceAccountRow[]>`
        INSERT INTO auth_service_accounts (
          project_id,
          id,
          name,
          description,
          status,
          created_by_user_id,
          created_by_service_account_id,
          created_by_system_id,
          created_by_session_id,
          created_at,
          updated_at
        ) VALUES (
          ${projectId},
          ${id},
          ${name},
          ${input.description ?? null},
          ${input.status ?? "active"},
          ${input.createdByPrincipal?.type === "user" ? input.createdByPrincipal.id : null},
          ${
            input.createdByPrincipal?.type === "serviceAccount" ? input.createdByPrincipal.id : null
          },
          ${input.createdByPrincipal?.type === "system" ? input.createdByPrincipal.id : null},
          ${input.createdBySessionId ?? null},
          ${createdAt},
          ${updatedAt}
        )
        RETURNING *
      `

      return rowToServiceAccountRecord(row)
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_service_account",
        `[Sixb] Service account '${id}' already exists for project '${projectId}'.`
      )
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ServiceAccountRecord | null> {
    const [row] = await this.sql<PgAuthServiceAccountRow[]>`
      SELECT *
      FROM auth_service_accounts
      WHERE project_id = ${params.projectId}
        AND id = ${params.id}
    `
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
    const [row] = await this.sql<PgAuthServiceAccountRow[]>`
      UPDATE auth_service_accounts
      SET name = ${name},
          description = ${description ?? null},
          status = ${input.status ?? existing.status},
          updated_at = ${updatedAt}
      WHERE project_id = ${input.projectId}
        AND id = ${input.id}
      RETURNING *
    `

    return rowToServiceAccountRecord(row)
  }

  async list(input: ListAuthServiceAccountsInput): Promise<ListAuthServiceAccountsResult> {
    if (hasEmptyFilter(input.statuses)) {
      return { serviceAccounts: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: PgValue[] = [input.projectId]
    let nextIndex = 2
    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => `$${nextIndex++}`).join(", ")})`)
      params.push(...input.statuses)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "desc" ? "DESC" : "ASC"
    const [totalRow] = await this.sql.unsafe<{ readonly count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM auth_service_accounts ${where}`,
      [...params]
    )
    const queryParams = [...params]
    const query = appendPagination(
      `
        SELECT *
        FROM auth_service_accounts
        ${where}
        ORDER BY created_at ${order}, id ${order}
      `,
      queryParams,
      nextIndex,
      input
    )
    const rows = await this.sql.unsafe<PgAuthServiceAccountRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)

    return {
      serviceAccounts: rows.map(rowToServiceAccountRecord),
      hasMore: input.limit === undefined ? false : (input.offset ?? 0) + input.limit < total,
      total,
    }
  }
}
