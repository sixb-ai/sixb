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
import type { SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgShareGrantStorage implements ShareGrantStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateShareGrantInput): Promise<ShareGrantRecord> {
    const record = normalizeShareGrantCreate(input)
    try {
      const [row] = await this.sql<PgShareGrantRow[]>`
        INSERT INTO share_grants (
          project_id,
          id,
          definition_id,
          target_object_type_id,
          target_primary_id,
          issued_by_type,
          issued_by_id,
          authority_version,
          authority_snapshot,
          authority_digest,
          token_hash,
          destination_path,
          created_at,
          expires_at
        ) VALUES (
          ${record.projectId},
          ${record.id},
          ${record.definitionId},
          ${record.target.objectTypeId},
          ${record.target.primaryId},
          ${record.issuedBy.type},
          ${record.issuedBy.id},
          ${record.authoritySnapshot.version},
          ${JSON.stringify(record.authoritySnapshot)}::text::jsonb,
          ${record.authorityDigest},
          ${record.tokenHash},
          ${record.destinationPath},
          ${record.createdAt},
          ${record.expiresAt}
        )
        RETURNING *
      `
      if (!row) {
        throw invalidRecord(`Share grant '${record.id}' disappeared after create.`)
      }
      return recordFromRow(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ShareGrantStorageError(
          "duplicate",
          `[SixbPg] Share grant '${record.id}' conflicts with an existing record.`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async getById(input: GetShareGrantByIdInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeGetShareGrantByIdInput(input)
    const [row] = await this.sql<PgShareGrantRow[]>`
      SELECT *
      FROM share_grants
      WHERE project_id = ${normalized.projectId} AND id = ${normalized.id}
    `
    return row ? recordFromRow(row) : null
  }

  async list(input: ListShareGrantsInput): Promise<ListShareGrantsResult> {
    const normalized = normalizeListShareGrantsInput(input)
    const where = ["project_id = $1"]
    const params: SqlParameter[] = [normalized.projectId]
    let parameter = 2

    if (normalized.definitionId !== undefined) {
      where.push(`definition_id = $${parameter++}`)
      params.push(normalized.definitionId)
    }
    if (normalized.target !== undefined) {
      where.push(`target_object_type_id = $${parameter++}`, `target_primary_id = $${parameter++}`)
      params.push(normalized.target.objectTypeId, normalized.target.primaryId)
    }
    if (!normalized.includeRevoked) where.push("revoked_at IS NULL")
    if (!normalized.includeExpired) {
      where.push(`expires_at > $${parameter++}`)
      params.push(normalized.now)
    }

    const predicate = where.join(" AND ")
    const [totalRow] = await this.sql.unsafe<PgShareGrantCountRow[]>(
      `SELECT COUNT(*)::bigint AS total FROM share_grants WHERE ${predicate}`,
      params
    )
    const total = parseCount(totalRow?.total)

    const listParams = [...params, normalized.limit, normalized.offset]
    const rows = await this.sql.unsafe<PgShareGrantRow[]>(
      `
        SELECT *
        FROM share_grants
        WHERE ${predicate}
        ORDER BY created_at DESC, id DESC
        LIMIT $${parameter++} OFFSET $${parameter}
      `,
      listParams
    )
    const grants = rows.map(recordFromRow)
    return {
      grants,
      total,
      hasMore: normalized.offset + grants.length < total,
    }
  }

  async revoke(input: RevokeShareGrantInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeRevokeShareGrantInput(input)
    const current = await this.getById({ projectId: normalized.projectId, id: normalized.id })
    if (!current) return null
    if (current.revokedAt) return current

    const revocation = normalizeRevokeShareGrantInput(normalized, current.createdAt)
    const [updated] = await this.sql<PgShareGrantRow[]>`
      UPDATE share_grants
      SET revoked_at = ${revocation.revokedAt},
          revoked_by_type = ${revocation.revokedBy.type},
          revoked_by_id = ${revocation.revokedBy.id}
      WHERE project_id = ${revocation.projectId}
        AND id = ${revocation.id}
        AND revoked_at IS NULL
      RETURNING *
    `
    if (updated) return recordFromRow(updated)

    return this.getById({ projectId: revocation.projectId, id: revocation.id })
  }
}

interface PgShareGrantRow {
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

interface PgShareGrantCountRow {
  readonly total: unknown
}

function recordFromRow(row: PgShareGrantRow): ShareGrantRecord {
  const authoritySnapshot = parseJsonColumn(row.authority_snapshot)
  if (
    !isRecord(authoritySnapshot) ||
    !Number.isSafeInteger(row.authority_version) ||
    authoritySnapshot.version !== row.authority_version
  ) {
    throw invalidRecord("Share authority version does not match its snapshot.")
  }

  return parseShareGrantRecord({
    id: row.id,
    projectId: row.project_id,
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
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.revoked_by_type === null && row.revoked_by_id === null
      ? {}
      : { revokedBy: { type: row.revoked_by_type, id: row.revoked_by_id } }),
  })
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch (error) {
    throw invalidRecord("Share authority snapshot is not valid JSON.", error)
  }
}

function parseCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw invalidRecord("Share grant count is not a non-negative safe integer.")
  }
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidRecord(message: string, cause?: unknown): ShareGrantStorageError {
  return new ShareGrantStorageError("invalid_record", `[SixbPg] ${message}`, { cause })
}
