import type { Database } from "bun:sqlite"
import {
  normalizeGetShareGrantByIdInput,
  normalizeListShareGrantsInput,
  normalizeRevokeShareGrantInput,
  normalizeShareGrantCreate,
  parseShareGrantRecord,
} from "@sixb/core/internal/share-grant-storage-provider"
import type {
  CreateShareGrantInput,
  GetShareGrantByIdInput,
  ListShareGrantsInput,
  ListShareGrantsResult,
  RevokeShareGrantInput,
  ShareGrantRecord,
  ShareGrantStorage,
} from "@sixb/core/storage"
import { ShareGrantStorageError } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteShareGrantStorageOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

/** SQLite persistence for issued Share grants. Secret handling remains in Core. */
export class SqliteShareGrantStorage implements ShareGrantStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteShareGrantStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.db)
  }

  async create(input: CreateShareGrantInput): Promise<ShareGrantRecord> {
    const record = normalizeShareGrantCreate(input)
    try {
      this.db
        .query(
          `
            INSERT INTO share_grants (
              project_id, id, definition_id, target_object_type_id, target_primary_id,
              issued_by_type, issued_by_id, authority_version, authority_snapshot,
              authority_digest, token_hash, destination_path, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          record.projectId,
          record.id,
          record.definitionId,
          record.target.objectTypeId,
          record.target.primaryId,
          record.issuedBy.type,
          record.issuedBy.id,
          record.authoritySnapshot.version,
          JSON.stringify(record.authoritySnapshot),
          record.authorityDigest,
          record.tokenHash,
          record.destinationPath,
          record.createdAt.toISOString(),
          record.expiresAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ShareGrantStorageError(
          "duplicate",
          `[SixbSqlite] Share grant '${record.id}' conflicts with an existing record.`,
          { cause: error }
        )
      }
      throw error
    }
    return this.require(record.projectId, record.id, "create")
  }

  async getById(input: GetShareGrantByIdInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeGetShareGrantByIdInput(input)
    return this.getRow(normalized.projectId, normalized.id)
  }

  async list(input: ListShareGrantsInput): Promise<ListShareGrantsResult> {
    const normalized = normalizeListShareGrantsInput(input)
    const where = ["project_id = ?"]
    const args: (string | number)[] = [normalized.projectId]
    if (normalized.definitionId !== undefined) {
      where.push("definition_id = ?")
      args.push(normalized.definitionId)
    }
    if (normalized.target !== undefined) {
      where.push("target_object_type_id = ?", "target_primary_id = ?")
      args.push(normalized.target.objectTypeId, normalized.target.primaryId)
    }
    if (!normalized.includeRevoked) where.push("revoked_at IS NULL")
    if (!normalized.includeExpired) {
      where.push("expires_at > ?")
      args.push(normalized.now.toISOString())
    }

    const predicate = where.join(" AND ")
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS total FROM share_grants WHERE ${predicate}`)
      .get(...args) as { readonly total: number }
    const rows = this.db
      .query(
        `
          SELECT * FROM share_grants
          WHERE ${predicate}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `
      )
      .all(...args, normalized.limit, normalized.offset) as SqliteShareGrantRow[]
    const grants = rows.map(rowToRecord)
    return {
      grants,
      total: totalRow.total,
      hasMore: normalized.offset + grants.length < totalRow.total,
    }
  }

  async revoke(input: RevokeShareGrantInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeRevokeShareGrantInput(input)
    const current = this.getRow(normalized.projectId, normalized.id)
    if (!current || current.revokedAt) return current

    const revocation = normalizeRevokeShareGrantInput(normalized, current.createdAt)
    this.db
      .query(
        `
          UPDATE share_grants
          SET revoked_at = ?, revoked_by_type = ?, revoked_by_id = ?
          WHERE project_id = ? AND id = ? AND revoked_at IS NULL
        `
      )
      .run(
        revocation.revokedAt.toISOString(),
        revocation.revokedBy.type,
        revocation.revokedBy.id,
        revocation.projectId,
        revocation.id
      )
    return this.require(revocation.projectId, revocation.id, "revoke")
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private getRow(projectId: string, id: string): ShareGrantRecord | null {
    const row = this.db
      .query("SELECT * FROM share_grants WHERE project_id = ? AND id = ?")
      .get(projectId, id) as SqliteShareGrantRow | null
    return row ? rowToRecord(row) : null
  }

  private require(projectId: string, id: string, operation: string): ShareGrantRecord {
    const record = this.getRow(projectId, id)
    if (!record) {
      throw new ShareGrantStorageError(
        "invalid_record",
        `[SixbSqlite] Share grant '${id}' disappeared after ${operation}.`
      )
    }
    return record
  }
}

interface SqliteShareGrantRow {
  readonly project_id: unknown
  readonly id: unknown
  readonly definition_id: unknown
  readonly target_object_type_id: unknown
  readonly target_primary_id: unknown
  readonly issued_by_type: unknown
  readonly issued_by_id: unknown
  readonly authority_version: unknown
  readonly authority_snapshot: unknown
  readonly authority_digest: unknown
  readonly token_hash: unknown
  readonly destination_path: unknown
  readonly created_at: unknown
  readonly expires_at: unknown
  readonly revoked_at: unknown
  readonly revoked_by_type: unknown
  readonly revoked_by_id: unknown
}

function rowToRecord(row: SqliteShareGrantRow): ShareGrantRecord {
  const authoritySnapshot = parseStoredJson(row.authority_snapshot, "authority snapshot")
  if (
    typeof row.authority_version !== "number" ||
    !isRecord(authoritySnapshot) ||
    authoritySnapshot.version !== row.authority_version
  ) {
    throw invalidRecord("Share authority version does not match its snapshot.")
  }

  const hasRevokedAt = row.revoked_at !== null
  const hasRevokedBy = row.revoked_by_type !== null || row.revoked_by_id !== null
  if (hasRevokedAt !== hasRevokedBy) {
    throw invalidRecord("Share revocation time and actor must be stored together.")
  }

  return parseShareGrantRecord({
    projectId: row.project_id,
    id: row.id,
    definitionId: row.definition_id,
    target: {
      objectTypeId: row.target_object_type_id,
      primaryId: row.target_primary_id,
    },
    issuedBy: { type: row.issued_by_type, id: row.issued_by_id },
    authoritySnapshot,
    authorityDigest: row.authority_digest,
    tokenHash: row.token_hash,
    destinationPath: row.destination_path,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(hasRevokedAt ? { revokedAt: row.revoked_at } : {}),
    ...(hasRevokedBy ? { revokedBy: { type: row.revoked_by_type, id: row.revoked_by_id } } : {}),
  })
}

function parseStoredJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw invalidRecord(`Share ${field} must be stored as JSON text.`)
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new ShareGrantStorageError(
      "invalid_record",
      `[SixbSqlite] Share ${field} contains invalid JSON.`,
      { cause }
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidRecord(message: string): ShareGrantStorageError {
  return new ShareGrantStorageError("invalid_record", `[SixbSqlite] ${message}`)
}
