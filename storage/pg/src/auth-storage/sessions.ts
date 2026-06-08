import type { AuthSessionStore, CreateAuthSessionInput, SessionRecord } from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SQL } from "../pg-client"
import { authLockKey, lockAdvisoryKeys, runPgTransaction } from "../transactions"
import type { PgAuthSessionRow } from "./rows"
import { rowToSessionRecord } from "./rows"
import {
  createSession,
  getSessionById,
  getSessionRowById,
  requireSessionById,
  revokeActiveSessionsForUser,
} from "./shared"

export class PgAuthSessionStore implements AuthSessionStore {
  constructor(private readonly sql: SQL) {}

  async create(input: CreateAuthSessionInput): Promise<SessionRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [
        authLockKey("sessions", input.projectId, input.userId),
        authLockKey("sessions", input.projectId, input.userId, input.audience),
      ])
      return createSession(tx, input)
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<SessionRecord | null> {
    return getSessionById(this.sql, params)
  }

  async getActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const [row] = await this.sql<PgAuthSessionRow[]>`
      SELECT *
      FROM auth_sessions
      WHERE project_id = ${params.projectId}
        AND user_id = ${params.userId}
        AND audience = ${params.audience}
        AND revoked_at IS NULL
        AND expires_at > ${params.now}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `

    return row ? rowToSessionRecord(row) : null
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly audience: string
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const row = await getSessionRowById(this.sql, params)

    if (
      !row ||
      row.audience !== params.audience ||
      row.token_hash !== params.tokenHash ||
      row.revoked_at ||
      new Date(row.expires_at) <= params.now
    ) {
      return null
    }

    return rowToSessionRecord(row)
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<SessionRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await getSessionRowById(tx, params, { forUpdate: true })

      if (!existing) {
        throw new AuthStorageError(
          "missing_session",
          `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
        )
      }

      const [row] = await tx<PgAuthSessionRow[]>`
        UPDATE auth_sessions
        SET revoked_at = ${params.revokedAt}
        WHERE project_id = ${params.projectId}
          AND id = ${params.id}
        RETURNING *
      `

      return rowToSessionRecord(row)
    })
  }

  async revokeActiveForUser(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: string
    readonly revokedAt: Date
  }): Promise<readonly SessionRecord[]> {
    return runPgTransaction(this.sql, async (tx) => {
      const locks = [authLockKey("sessions", params.projectId, params.userId)]
      if (params.audience) {
        locks.push(authLockKey("sessions", params.projectId, params.userId, params.audience))
      }
      await lockAdvisoryKeys(tx, locks)
      return revokeActiveSessionsForUser(tx, params)
    })
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastSeenAt: Date
  }): Promise<SessionRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await requireSessionById(tx, params)

      const [row] = await tx<PgAuthSessionRow[]>`
        UPDATE auth_sessions
        SET last_seen_at = ${params.lastSeenAt}
        WHERE project_id = ${params.projectId}
          AND id = ${params.id}
        RETURNING *
      `

      return rowToSessionRecord(row)
    })
  }
}
