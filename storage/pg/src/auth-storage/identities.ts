import type {
  AuthUserIdentityStore,
  UpsertAuthUserIdentityInput,
  UserIdentityRecord,
} from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import type { PgAuthUserIdentityRow } from "./rows"
import { rowToIdentityRecord, serializeOptionalRecord } from "./rows"
import { assertNonEmpty, dateOrNow, getIdentityRowBySubject, requireUserById } from "./shared"

export class PgAuthUserIdentityStore implements AuthUserIdentityStore {
  constructor(private readonly sql: PgStoreClient) {}

  async upsert(input: UpsertAuthUserIdentityInput): Promise<UserIdentityRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const subject = assertNonEmpty(input.subject, "Subject")
    const userId = assertNonEmpty(input.userId, "User id")
    const existing = await getIdentityRowBySubject(this.sql, {
      projectId,
      strategyId,
      subject,
    })
    const createdAt = existing ? new Date(existing.created_at) : dateOrNow(input.createdAt)
    const updatedAt = input.updatedAt
      ? new Date(input.updatedAt)
      : existing
        ? new Date()
        : createdAt

    await requireUserById(this.sql, { projectId, id: userId })

    const [row] = await this.sql<PgAuthUserIdentityRow[]>`
      INSERT INTO auth_user_identities (
        project_id,
        strategy_id,
        subject,
        user_id,
        claims,
        created_at,
        updated_at
      ) VALUES (
        ${projectId},
        ${strategyId},
        ${subject},
        ${userId},
        ${serializeOptionalRecord(input.claims)}::text::jsonb,
        ${createdAt},
        ${updatedAt}
      )
      ON CONFLICT (project_id, strategy_id, subject)
      DO UPDATE SET
        user_id = excluded.user_id,
        claims = excluded.claims,
        updated_at = excluded.updated_at
      RETURNING *
    `

    return rowToIdentityRecord(row)
  }

  async getBySubject(params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  }): Promise<UserIdentityRecord | null> {
    const row = await getIdentityRowBySubject(this.sql, params)
    return row ? rowToIdentityRecord(row) : null
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly UserIdentityRecord[]> {
    const rows = await this.sql<PgAuthUserIdentityRow[]>`
      SELECT *
      FROM auth_user_identities
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
      ORDER BY created_at ASC, strategy_id ASC, subject ASC
    `

    return rows.map(rowToIdentityRecord)
  }
}
