import type { Database } from "bun:sqlite"
import type {
  CreateSharedAccessSessionInput,
  GetSharedAccessSessionInput,
  RevokeSharedAccessSessionInput,
  SharedAccessSessionRecord,
  ShareSessionStorage,
} from "@sixb/core/storage"
import {
  assertSharedAccessSessionRevocation,
  normalizeSharedAccessSession,
  ShareSessionStorageError,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteShareSessionStorageOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

export class SqliteShareSessionStorage implements ShareSessionStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteShareSessionStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.db)
  }

  async create(input: CreateSharedAccessSessionInput): Promise<SharedAccessSessionRecord> {
    const record = normalizeSharedAccessSession(input)
    try {
      this.db
        .query(
          `
            INSERT INTO share_sessions (
              project_id, id, grant_id, token_digest, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          record.projectId,
          record.id,
          record.grantId,
          record.tokenDigest,
          record.createdAt.toISOString(),
          record.expiresAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ShareSessionStorageError(
          `[SixbSqlite] Shared access session '${record.id}' conflicts with an existing record.`,
          "duplicate",
          { cause: error }
        )
      }
      throw error
    }
    return this.require(record.projectId, record.id, "create")
  }

  async get(input: GetSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    return this.getRow(input.projectId, input.sessionId)
  }

  async revoke(input: RevokeSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    assertSharedAccessSessionRevocation(input)
    const current = this.getRow(input.projectId, input.sessionId)
    if (!current || current.revokedAt) return current
    assertSharedAccessSessionRevocation(input, current.createdAt)
    this.db
      .query(
        `
          UPDATE share_sessions
          SET revoked_at = ?
          WHERE project_id = ? AND id = ? AND revoked_at IS NULL
        `
      )
      .run(input.revokedAt.toISOString(), input.projectId, input.sessionId)
    return this.require(input.projectId, input.sessionId, "revoke")
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private getRow(projectId: string, sessionId: string): SharedAccessSessionRecord | null {
    const row = this.db
      .query("SELECT * FROM share_sessions WHERE project_id = ? AND id = ?")
      .get(projectId, sessionId) as SqliteShareSessionRow | null
    return row ? rowToRecord(row) : null
  }

  private require(projectId: string, sessionId: string, operation: string) {
    const row = this.getRow(projectId, sessionId)
    if (!row) {
      throw new Error(
        `[SixbSqlite] Shared access session disappeared after ${operation}: '${sessionId}'.`
      )
    }
    return row
  }
}

interface SqliteShareSessionRow {
  readonly project_id: string
  readonly id: string
  readonly grant_id: string
  readonly token_digest: string
  readonly created_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
}

function rowToRecord(row: SqliteShareSessionRow): SharedAccessSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    grantId: row.grant_id,
    tokenDigest: row.token_digest,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: new Date(row.revoked_at) }),
  }
}
