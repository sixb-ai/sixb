import type { Database } from "bun:sqlite"
import {
  normalizeGetShareSessionByIdInput,
  normalizeRenewShareSessionIfValidInput,
  normalizeRevokeShareSessionInput,
  normalizeShareSessionCreate,
  parseShareSessionRecord,
} from "@sixb/core/internal/share-session-storage-provider"
import type {
  CreateShareSessionInput,
  GetShareSessionByIdInput,
  RenewShareSessionIfValidInput,
  RevokeShareSessionInput,
  ShareSessionRecord,
  ShareSessionStorage,
} from "@sixb/core/storage"
import { ShareSessionStorageError } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { isForeignKeyConstraintError, isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteShareSessionStorageOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

/** SQLite persistence for short-lived Share access sessions. */
export class SqliteShareSessionStorage implements ShareSessionStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteShareSessionStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.db)
  }

  async create(input: CreateShareSessionInput): Promise<ShareSessionRecord> {
    const record = normalizeShareSessionCreate(input)
    try {
      const row = this.db
        .query(
          `
            INSERT INTO share_sessions (
              project_id, id, grant_id, token_hash, created_at, expires_at,
              absolute_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING *
          `
        )
        .get(
          record.projectId,
          record.id,
          record.grantId,
          record.tokenHash,
          record.createdAt.toISOString(),
          record.expiresAt.toISOString(),
          record.absoluteExpiresAt.toISOString()
        ) as SqliteShareSessionRow | null
      if (!row) throw invalidRecord(`Share session '${record.id}' disappeared after create.`)
      return rowToRecord(row)
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ShareSessionStorageError(
          "duplicate",
          `[SixbSqlite] Share session '${record.id}' conflicts with an existing record.`,
          { cause: error }
        )
      }
      if (isForeignKeyConstraintError(error)) {
        throw new ShareSessionStorageError(
          "invalid_input",
          `[SixbSqlite] Share grant '${record.grantId}' does not exist in project '${record.projectId}'.`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async getById(input: GetShareSessionByIdInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeGetShareSessionByIdInput(input)
    return this.getRow(normalized.projectId, normalized.id)
  }

  async renewIfValid(input: RenewShareSessionIfValidInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRenewShareSessionIfValidInput(input)
    const requestedExpiry = normalized.expiresAt.toISOString()
    const now = normalized.now.toISOString()
    const row = this.db
      .query(
        `
          UPDATE share_sessions
          SET expires_at = CASE
            WHEN ? > absolute_expires_at THEN absolute_expires_at
            WHEN ? > expires_at THEN ?
            ELSE expires_at
          END
          WHERE project_id = ?
            AND id = ?
            AND grant_id = ?
            AND token_hash = ?
            AND revoked_at IS NULL
            AND created_at <= ?
            AND expires_at > ?
            AND absolute_expires_at > ?
          RETURNING *
        `
      )
      .get(
        requestedExpiry,
        requestedExpiry,
        requestedExpiry,
        normalized.projectId,
        normalized.id,
        normalized.grantId,
        normalized.tokenHash,
        now,
        now,
        now
      ) as SqliteShareSessionRow | null
    return row ? rowToRecord(row) : null
  }

  async revoke(input: RevokeShareSessionInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRevokeShareSessionInput(input)
    const current = this.getRow(normalized.projectId, normalized.id)
    if (!current || current.revokedAt) return current
    const revocation = normalizeRevokeShareSessionInput(normalized, current.createdAt)
    const row = this.db
      .query(
        `
          UPDATE share_sessions
          SET revoked_at = ?
          WHERE project_id = ? AND id = ? AND revoked_at IS NULL
          RETURNING *
        `
      )
      .get(
        revocation.revokedAt.toISOString(),
        revocation.projectId,
        revocation.id
      ) as SqliteShareSessionRow | null
    return row ? rowToRecord(row) : this.getRow(revocation.projectId, revocation.id)
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private getRow(projectId: string, id: string): ShareSessionRecord | null {
    const row = this.db
      .query("SELECT * FROM share_sessions WHERE project_id = ? AND id = ?")
      .get(projectId, id) as SqliteShareSessionRow | null
    return row ? rowToRecord(row) : null
  }
}

interface SqliteShareSessionRow {
  readonly project_id: unknown
  readonly id: unknown
  readonly grant_id: unknown
  readonly token_hash: unknown
  readonly created_at: unknown
  readonly expires_at: unknown
  readonly absolute_expires_at: unknown
  readonly revoked_at: unknown
}

function rowToRecord(row: SqliteShareSessionRow): ShareSessionRecord {
  return parseShareSessionRecord({
    projectId: row.project_id,
    id: row.id,
    grantId: row.grant_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  })
}

function invalidRecord(message: string): ShareSessionStorageError {
  return new ShareSessionStorageError("invalid_record", `[SixbSqlite] ${message}`)
}
