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
import type { SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgShareGrantStorage implements ShareGrantStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateSharedAccessGrantInput): Promise<SharedAccessGrantRecord> {
    const record = normalizeSharedAccessGrant(input)
    try {
      const [row] = await this.sql<PgShareGrantRow[]>`
        INSERT INTO share_grants (
          project_id, id, share_type_id, object_type_id, primary_id,
          issued_by_type, issued_by_id, grants, token_digest,
          created_at, expires_at
        ) VALUES (
          ${record.projectId}, ${record.id}, ${record.shareTypeId},
          ${record.target.objectTypeId}, ${record.target.primaryId},
          ${record.issuedBy.type}, ${record.issuedBy.id},
          ${JSON.stringify(record.grants)}::text::jsonb, ${record.tokenDigest},
          ${record.createdAt}, ${record.expiresAt}
        )
        RETURNING *
      `
      if (!row) throw new Error(`[SixbPg] Share grant '${record.id}' disappeared after create.`)
      return rowToRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ShareGrantStorageError(
          `[SixbPg] Shared access grant '${record.id}' conflicts with an existing record.`,
          "duplicate",
          { cause: error }
        )
      }
      throw error
    }
  }

  async get(input: GetSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    const [row] = await this.sql<PgShareGrantRow[]>`
      SELECT * FROM share_grants
      WHERE project_id = ${input.projectId} AND id = ${input.grantId}
    `
    return row ? rowToRecord(row) : null
  }

  async list(input: ListSharedAccessGrantsInput): Promise<readonly SharedAccessGrantRecord[]> {
    const where = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2
    if (input.shareTypeId !== undefined) {
      where.push(`share_type_id = $${index++}`)
      params.push(input.shareTypeId)
    }
    if (input.target !== undefined) {
      where.push(`object_type_id = $${index++}`, `primary_id = $${index++}`)
      params.push(input.target.objectTypeId, input.target.primaryId)
    }
    if (input.includeRevoked !== true) where.push("revoked_at IS NULL")
    if (input.includeExpired !== true) {
      where.push(`expires_at > $${index++}`)
      params.push(input.now ?? new Date())
    }
    const rows = await this.sql.unsafe<PgShareGrantRow[]>(
      `SELECT * FROM share_grants WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id`,
      params
    )
    return rows.map(rowToRecord)
  }

  async revoke(input: RevokeSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    assertSharedAccessGrantRevocation(input)
    const current = await this.get(input)
    if (!current || current.revokedAt) return current
    assertSharedAccessGrantRevocation(input, current.createdAt)
    const [updated] = await this.sql<PgShareGrantRow[]>`
      UPDATE share_grants
      SET revoked_at = ${input.revokedAt},
          revoked_by_type = ${input.revokedBy.type},
          revoked_by_id = ${input.revokedBy.id}
      WHERE project_id = ${input.projectId}
        AND id = ${input.grantId}
        AND revoked_at IS NULL
      RETURNING *
    `
    if (updated) return rowToRecord(updated)
    return this.get(input)
  }
}

interface PgShareGrantRow {
  readonly project_id: string
  readonly id: string
  readonly share_type_id: string
  readonly object_type_id: string
  readonly primary_id: string
  readonly issued_by_type: AuthorizablePrincipal["type"]
  readonly issued_by_id: string
  readonly grants: unknown
  readonly token_digest: string
  readonly created_at: Date | string
  readonly expires_at: Date | string
  readonly revoked_at: Date | string | null
  readonly revoked_by_type: Principal["type"] | null
  readonly revoked_by_id: string | null
}

function rowToRecord(row: PgShareGrantRow): SharedAccessGrantRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    shareTypeId: row.share_type_id,
    target: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
    issuedBy: { type: row.issued_by_type, id: row.issued_by_id },
    grants: normalizeSharedAccessGrantRefs(row.grants),
    tokenDigest: row.token_digest,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: toDate(row.revoked_at) }),
    ...(row.revoked_by_type === null || row.revoked_by_id === null
      ? {}
      : { revokedBy: { type: row.revoked_by_type, id: row.revoked_by_id } }),
  }
}

function toDate(value: Date | string): Date {
  return new Date(value instanceof Date ? value.getTime() : value)
}
