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
import { isForeignKeyViolation, isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgShareSessionStorage implements ShareSessionStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateShareSessionInput): Promise<ShareSessionRecord> {
    const record = normalizeShareSessionCreate(input)
    try {
      const [row] = await this.sql<PgShareSessionRow[]>`
        INSERT INTO share_sessions (
          project_id, id, grant_id, token_hash, created_at, expires_at, absolute_expires_at
        ) VALUES (
          ${record.projectId}, ${record.id}, ${record.grantId}, ${record.tokenHash},
          ${record.createdAt}, ${record.expiresAt}, ${record.absoluteExpiresAt}
        )
        RETURNING *
      `
      if (!row) throw invalidRecord(`Share session '${record.id}' disappeared after create.`)
      return recordFromRow(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ShareSessionStorageError(
          "duplicate",
          `[SixbPg] Share session '${record.id}' conflicts with an existing record.`,
          { cause: error }
        )
      }
      if (isForeignKeyViolation(error)) {
        throw new ShareSessionStorageError(
          "invalid_input",
          `[SixbPg] Share grant '${record.grantId}' does not exist in project '${record.projectId}'.`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async getById(input: GetShareSessionByIdInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeGetShareSessionByIdInput(input)
    const [row] = await this.sql<PgShareSessionRow[]>`
      SELECT * FROM share_sessions
      WHERE project_id = ${normalized.projectId} AND id = ${normalized.id}
    `
    return row ? recordFromRow(row) : null
  }

  async renewIfValid(input: RenewShareSessionIfValidInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRenewShareSessionIfValidInput(input)
    const [row] = await this.sql<PgShareSessionRow[]>`
      UPDATE share_sessions
      SET expires_at = LEAST(absolute_expires_at, GREATEST(expires_at, ${normalized.expiresAt}))
      WHERE project_id = ${normalized.projectId}
        AND id = ${normalized.id}
        AND grant_id = ${normalized.grantId}
        AND token_hash = ${normalized.tokenHash}
        AND revoked_at IS NULL
        AND created_at <= ${normalized.now}
        AND expires_at > ${normalized.now}
        AND absolute_expires_at > ${normalized.now}
      RETURNING *
    `
    return row ? recordFromRow(row) : null
  }

  async revoke(input: RevokeShareSessionInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRevokeShareSessionInput(input)
    const current = await this.getById(normalized)
    if (!current || current.revokedAt) return current
    const revocation = normalizeRevokeShareSessionInput(normalized, current.createdAt)
    const [updated] = await this.sql<PgShareSessionRow[]>`
      UPDATE share_sessions
      SET revoked_at = ${revocation.revokedAt}
      WHERE project_id = ${revocation.projectId}
        AND id = ${revocation.id}
        AND revoked_at IS NULL
      RETURNING *
    `
    if (updated) return recordFromRow(updated)
    return this.getById({ projectId: revocation.projectId, id: revocation.id })
  }
}

interface PgShareSessionRow {
  readonly project_id: unknown
  readonly id: unknown
  readonly grant_id: unknown
  readonly token_hash: unknown
  readonly created_at: unknown
  readonly expires_at: unknown
  readonly absolute_expires_at: unknown
  readonly revoked_at: unknown
}

function recordFromRow(row: PgShareSessionRow): ShareSessionRecord {
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

function invalidRecord(message: string, cause?: unknown): ShareSessionStorageError {
  return new ShareSessionStorageError("invalid_record", `[SixbPg] ${message}`, { cause })
}
