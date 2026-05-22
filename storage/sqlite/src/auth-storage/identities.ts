import type { Database } from "bun:sqlite"
import type {
  AuthUserIdentityStore,
  UpsertAuthUserIdentityInput,
  UserIdentityRecord,
} from "@pario/core"
import type { SqliteAuthUserIdentityRow } from "./rows"
import { rowToIdentityRecord, serializeOptionalRecord } from "./rows"
import { assertNonEmpty, dateOrNow, getIdentityRowBySubject, toIso } from "./shared"

export class SqliteAuthUserIdentityStore implements AuthUserIdentityStore {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertAuthUserIdentityInput): Promise<UserIdentityRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const subject = assertNonEmpty(input.subject, "Subject")
    const userId = assertNonEmpty(input.userId, "User id")
    const existing = getIdentityRowBySubject(this.db, {
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

    this.db
      .query(
        `
        INSERT INTO auth_user_identities (
          project_id,
          strategy_id,
          subject,
          user_id,
          claims,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, strategy_id, subject)
        DO UPDATE SET
          user_id = excluded.user_id,
          claims = excluded.claims,
          updated_at = excluded.updated_at
      `
      )
      .run(
        projectId,
        strategyId,
        subject,
        userId,
        serializeOptionalRecord(input.claims),
        toIso(createdAt),
        toIso(updatedAt)
      )

    return {
      projectId,
      strategyId,
      subject,
      userId,
      claims: input.claims ? structuredClone(input.claims) : undefined,
      createdAt,
      updatedAt,
    }
  }

  async getBySubject(params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  }): Promise<UserIdentityRecord | null> {
    const row = getIdentityRowBySubject(this.db, params)
    return row ? rowToIdentityRecord(row) : null
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly UserIdentityRecord[]> {
    const rows = this.db
      .query(
        `
        SELECT *
        FROM auth_user_identities
        WHERE project_id = ?
          AND user_id = ?
        ORDER BY created_at ASC, strategy_id ASC, subject ASC
      `
      )
      .all(params.projectId, params.userId) as SqliteAuthUserIdentityRow[]

    return rows.map(rowToIdentityRecord)
  }
}
