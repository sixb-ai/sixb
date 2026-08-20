import type { Database } from "bun:sqlite"
import type {
  AuthorizablePrincipal,
  CreateSharedAccessGrantInput,
  GetSharedAccessGrantInput,
  ListSharedAccessGrantsInput,
  Principal,
  RevokeSharedAccessGrantInput,
  SharedAccessGrantRecord,
  ShareGrantStorage,
} from "@sixb/core/storage"
import {
  assertSharedAccessGrantRevocation,
  normalizeSharedAccessGrant,
  normalizeSharedAccessGrantRefs,
  ShareGrantStorageError,
} from "@sixb/core/storage"
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

export class SqliteShareGrantStorage implements ShareGrantStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteShareGrantStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.db)
  }

  async create(input: CreateSharedAccessGrantInput): Promise<SharedAccessGrantRecord> {
    const record = normalizeSharedAccessGrant(input)
    try {
      this.db
        .query(
          `
            INSERT INTO share_grants (
              project_id, id, share_type_id, object_type_id, primary_id,
              issued_by_type, issued_by_id, grants, token_digest,
              created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          record.projectId,
          record.id,
          record.shareTypeId,
          record.target.objectTypeId,
          record.target.primaryId,
          record.issuedBy.type,
          record.issuedBy.id,
          JSON.stringify(record.grants),
          record.tokenDigest,
          record.createdAt.toISOString(),
          record.expiresAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ShareGrantStorageError(
          `[SixbSqlite] Shared access grant '${record.id}' conflicts with an existing record.`,
          "duplicate",
          { cause: error }
        )
      }
      throw error
    }
    return this.require(record.projectId, record.id, "create")
  }

  async get(input: GetSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    return this.getRow(input.projectId, input.grantId)
  }

  async list(input: ListSharedAccessGrantsInput): Promise<readonly SharedAccessGrantRecord[]> {
    const where = ["project_id = ?"]
    const args: string[] = [input.projectId]
    if (input.shareTypeId !== undefined) {
      where.push("share_type_id = ?")
      args.push(input.shareTypeId)
    }
    if (input.target !== undefined) {
      where.push("object_type_id = ?", "primary_id = ?")
      args.push(input.target.objectTypeId, input.target.primaryId)
    }
    if (input.includeRevoked !== true) where.push("revoked_at IS NULL")
    if (input.includeExpired !== true) {
      where.push("expires_at > ?")
      args.push((input.now ?? new Date()).toISOString())
    }

    const rows = this.db
      .query(`SELECT * FROM share_grants WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id`)
      .all(...args) as SqliteShareGrantRow[]
    return rows.map(rowToRecord)
  }

  async revoke(input: RevokeSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    assertSharedAccessGrantRevocation(input)
    const current = this.getRow(input.projectId, input.grantId)
    if (!current || current.revokedAt) return current
    assertSharedAccessGrantRevocation(input, current.createdAt)
    this.db
      .query(
        `
          UPDATE share_grants
          SET revoked_at = ?, revoked_by_type = ?, revoked_by_id = ?
          WHERE project_id = ? AND id = ? AND revoked_at IS NULL
        `
      )
      .run(
        input.revokedAt.toISOString(),
        input.revokedBy.type,
        input.revokedBy.id,
        input.projectId,
        input.grantId
      )
    return this.require(input.projectId, input.grantId, "revoke")
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private getRow(projectId: string, grantId: string): SharedAccessGrantRecord | null {
    const row = this.db
      .query("SELECT * FROM share_grants WHERE project_id = ? AND id = ?")
      .get(projectId, grantId) as SqliteShareGrantRow | null
    return row ? rowToRecord(row) : null
  }

  private require(projectId: string, grantId: string, operation: string): SharedAccessGrantRecord {
    const row = this.getRow(projectId, grantId)
    if (!row) {
      throw new Error(`[SixbSqlite] Share grant disappeared after ${operation}: '${grantId}'.`)
    }
    return row
  }
}

interface SqliteShareGrantRow {
  readonly project_id: string
  readonly id: string
  readonly share_type_id: string
  readonly object_type_id: string
  readonly primary_id: string
  readonly issued_by_type: AuthorizablePrincipal["type"]
  readonly issued_by_id: string
  readonly grants: string
  readonly token_digest: string
  readonly created_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
  readonly revoked_by_type: Principal["type"] | null
  readonly revoked_by_id: string | null
}

function rowToRecord(row: SqliteShareGrantRow): SharedAccessGrantRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    shareTypeId: row.share_type_id,
    target: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
    issuedBy: { type: row.issued_by_type, id: row.issued_by_id },
    grants: normalizeSharedAccessGrantRefs(JSON.parse(row.grants)),
    tokenDigest: row.token_digest,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: new Date(row.revoked_at) }),
    ...(row.revoked_by_type === null || row.revoked_by_id === null
      ? {}
      : { revokedBy: { type: row.revoked_by_type, id: row.revoked_by_id } }),
  }
}
