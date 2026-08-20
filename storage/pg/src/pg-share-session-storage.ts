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
import { isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgShareSessionStorage implements ShareSessionStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateSharedAccessSessionInput): Promise<SharedAccessSessionRecord> {
    const record = normalizeSharedAccessSession(input)
    try {
      const [row] = await this.sql<PgShareSessionRow[]>`
        INSERT INTO share_sessions (
          project_id, id, grant_id, token_digest, created_at, expires_at
        ) VALUES (
          ${record.projectId}, ${record.id}, ${record.grantId}, ${record.tokenDigest},
          ${record.createdAt}, ${record.expiresAt}
        )
        RETURNING *
      `
      if (!row) {
        throw new Error(`[SixbPg] Shared access session '${record.id}' disappeared after create.`)
      }
      return rowToRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ShareSessionStorageError(
          `[SixbPg] Shared access session '${record.id}' conflicts with an existing record.`,
          "duplicate",
          { cause: error }
        )
      }
      throw error
    }
  }

  async get(input: GetSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    const [row] = await this.sql<PgShareSessionRow[]>`
      SELECT * FROM share_sessions
      WHERE project_id = ${input.projectId} AND id = ${input.sessionId}
    `
    return row ? rowToRecord(row) : null
  }

  async revoke(input: RevokeSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    assertSharedAccessSessionRevocation(input)
    const current = await this.get(input)
    if (!current || current.revokedAt) return current
    assertSharedAccessSessionRevocation(input, current.createdAt)
    const [updated] = await this.sql<PgShareSessionRow[]>`
      UPDATE share_sessions
      SET revoked_at = ${input.revokedAt}
      WHERE project_id = ${input.projectId}
        AND id = ${input.sessionId}
        AND revoked_at IS NULL
      RETURNING *
    `
    if (updated) return rowToRecord(updated)
    return this.get(input)
  }
}

interface PgShareSessionRow {
  readonly project_id: string
  readonly id: string
  readonly grant_id: string
  readonly token_digest: string
  readonly created_at: Date | string
  readonly expires_at: Date | string
  readonly revoked_at: Date | string | null
}

function rowToRecord(row: PgShareSessionRow): SharedAccessSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    grantId: row.grant_id,
    tokenDigest: row.token_digest,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: toDate(row.revoked_at) }),
  }
}

function toDate(value: Date | string): Date {
  return new Date(value instanceof Date ? value.getTime() : value)
}
