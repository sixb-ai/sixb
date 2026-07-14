import type { Database } from "bun:sqlite"
import type {
  AuthSessionAudience,
  AuthSessionStore,
  CreateAuthSessionInput,
  SessionRecord,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import { runImmediateTransaction } from "../transactions"
import type { SqliteAuthSessionRow } from "./rows"
import { rowToSessionRecord } from "./rows"
import {
  createSession,
  getSessionById,
  getSessionRowById,
  requireSessionById,
  revokeActiveSessionsForUser,
  toIso,
} from "./shared"

export class SqliteAuthSessionStore implements AuthSessionStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthSessionInput): Promise<SessionRecord> {
    return runImmediateTransaction(this.db, () => createSession(this.db, input))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<SessionRecord | null> {
    return getSessionById(this.db, params)
  }

  async getActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience: AuthSessionAudience
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const row = this.db
      .query(
        `
        SELECT *
        FROM auth_sessions
        WHERE project_id = ?
          AND user_id = ?
          AND audience = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .get(
        params.projectId,
        params.userId,
        params.audience,
        toIso(params.now),
        toIso(params.now)
      ) as SqliteAuthSessionRow | null

    return row ? rowToSessionRecord(row) : null
  }

  async listActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly now: Date
  }): Promise<readonly SessionRecord[]> {
    const rows = this.db
      .query(
        `
        SELECT *
        FROM auth_sessions
        WHERE project_id = ?
          AND user_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
        ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC, id DESC
      `
      )
      .all(
        params.projectId,
        params.userId,
        toIso(params.now),
        toIso(params.now)
      ) as SqliteAuthSessionRow[]

    return rows.map(rowToSessionRecord)
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly audience: AuthSessionAudience
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const row = getSessionRowById(this.db, params)

    if (
      !row ||
      row.audience !== params.audience ||
      row.token_hash !== params.tokenHash ||
      row.revoked_at ||
      new Date(row.expires_at) <= params.now ||
      (row.absolute_expires_at !== null && new Date(row.absolute_expires_at) <= params.now)
    ) {
      return null
    }

    return rowToSessionRecord(row)
  }

  async renewIfValid(params: {
    readonly projectId: string
    readonly id: string
    readonly audience: AuthSessionAudience
    readonly tokenHash: string
    readonly now: Date
    readonly expiresAt: Date
  }): Promise<SessionRecord | null> {
    return runImmediateTransaction(this.db, () => {
      const now = toIso(params.now)
      const expiresAt = toIso(params.expiresAt)
      const result = this.db
        .query(
          `
          UPDATE auth_sessions
          SET expires_at = MAX(
                expires_at,
                MIN(?, COALESCE(absolute_expires_at, ?))
              ),
              last_seen_at = ?
          WHERE project_id = ?
            AND id = ?
            AND audience = ?
            AND token_hash = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
        `
        )
        .run(
          expiresAt,
          expiresAt,
          now,
          params.projectId,
          params.id,
          params.audience,
          params.tokenHash,
          now,
          now
        )

      return result.changes === 0 ? null : getSessionById(this.db, params)
    })
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<SessionRecord> {
    return runImmediateTransaction(this.db, () => {
      const existing = getSessionRowById(this.db, params)

      if (!existing) {
        throw new AuthStorageError(
          "missing_session",
          `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE auth_sessions
          SET revoked_at = ?
          WHERE project_id = ?
            AND id = ?
        `
        )
        .run(toIso(params.revokedAt), params.projectId, params.id)

      return rowToSessionRecord({
        ...existing,
        revoked_at: toIso(params.revokedAt),
      })
    })
  }

  async revokeActiveForUser(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: AuthSessionAudience
    readonly revokedAt: Date
  }): Promise<readonly SessionRecord[]> {
    return runImmediateTransaction(this.db, () => revokeActiveSessionsForUser(this.db, params))
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastSeenAt: Date
  }): Promise<SessionRecord> {
    return runImmediateTransaction(this.db, () => {
      requireSessionById(this.db, params)

      this.db
        .query(
          `
          UPDATE auth_sessions
          SET last_seen_at = ?
          WHERE project_id = ?
            AND id = ?
        `
        )
        .run(toIso(params.lastSeenAt), params.projectId, params.id)

      const updated = getSessionById(this.db, params)
      if (!updated) {
        throw new AuthStorageError(
          "missing_session",
          `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
        )
      }
      return updated
    })
  }
}
