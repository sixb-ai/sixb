import type { Database } from "bun:sqlite"
import { parseLakeSliceGrantRow, parseLakeSliceRow } from "@sixb/core/internal/storage"
import type {
  DeleteExpiredLakeSlicesInput,
  LakeSliceGrantRecord,
  LakeSliceRecord,
  LakeSliceRef,
  LakeSliceStorage,
  ListLiveLakeSlicesInput,
} from "@sixb/core/storage"
import type { SqliteStoreConnection } from "./transactions"

const SLICE_COLUMNS = `
  project_id AS projectId, id, user_id AS userId, branch, point, versions, files,
  created_at AS createdAt, last_token_expires_at AS lastTokenExpiresAt,
  credential_hash AS credentialHash, credential_group_ids AS credentialGroupIds,
  credential_minted_by_type AS credentialMintedByType,
  credential_minted_by_id AS credentialMintedById,
  received_at AS receivedAt
`
const LIVE_UNTIL = "coalesce(last_token_expires_at, created_at)"

export class SqliteLakeSliceStorage implements LakeSliceStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async create(record: LakeSliceRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO lake_slices (
          project_id, id, user_id, branch, point, versions, files, created_at, last_token_expires_at,
          credential_hash, credential_group_ids, credential_minted_by_type, credential_minted_by_id,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.projectId,
        record.id,
        record.userId,
        record.branch,
        record.point,
        JSON.stringify(record.versions),
        JSON.stringify(record.files),
        record.createdAt.toISOString(),
        record.lastTokenExpiresAt?.toISOString() ?? null,
        record.credentialHash ?? null,
        record.credentialGroupIds ? JSON.stringify(record.credentialGroupIds) : null,
        record.credentialMintedBy?.type ?? null,
        record.credentialMintedBy?.id ?? null,
        record.receivedAt?.toISOString() ?? null
      )
  }

  async get(input: LakeSliceRef): Promise<LakeSliceRecord | null> {
    const row = this.db
      .query(`SELECT ${SLICE_COLUMNS} FROM lake_slices WHERE project_id = ? AND id = ?`)
      .get(input.projectId, input.id)
    return row ? parseLakeSliceRow(row as Record<string, unknown>) : null
  }

  async delete(input: LakeSliceRef): Promise<void> {
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM lake_slice_grants WHERE project_id = ? AND slice_id = ?")
        .run(input.projectId, input.id)
      this.db
        .query("DELETE FROM lake_slices WHERE project_id = ? AND id = ?")
        .run(input.projectId, input.id)
    })()
  }

  async createGrant(record: LakeSliceGrantRecord): Promise<void> {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO lake_slice_grants (project_id, id, token_hash, slice_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.projectId,
          record.id,
          record.tokenHash,
          record.sliceId,
          record.createdAt.toISOString(),
          record.expiresAt.toISOString()
        )
      this.db
        .query(
          `UPDATE lake_slices SET last_token_expires_at = max(coalesce(last_token_expires_at, ?), ?)
           WHERE project_id = ? AND id = ?`
        )
        .run(
          record.expiresAt.toISOString(),
          record.expiresAt.toISOString(),
          record.projectId,
          record.sliceId
        )
    })()
  }

  async markReceived(input: LakeSliceRef & { readonly at: Date }): Promise<void> {
    this.db
      .query(
        "UPDATE lake_slices SET received_at = coalesce(received_at, ?) WHERE project_id = ? AND id = ?"
      )
      .run(input.at.toISOString(), input.projectId, input.id)
  }

  async findByCredentialHash(input: {
    readonly projectId: string
    readonly credentialHash: string
  }): Promise<LakeSliceRecord | null> {
    const row = this.db
      .query(
        `SELECT ${SLICE_COLUMNS} FROM lake_slices WHERE project_id = ? AND credential_hash = ?`
      )
      .get(input.projectId, input.credentialHash) as Record<string, unknown> | null
    return row ? parseLakeSliceRow(row) : null
  }

  async findGrantByTokenHash(input: {
    readonly projectId: string
    readonly tokenHash: string
  }): Promise<LakeSliceGrantRecord | null> {
    const row = this.db
      .query(
        `SELECT project_id AS projectId, id, token_hash AS tokenHash, slice_id AS sliceId,
          created_at AS createdAt, expires_at AS expiresAt
         FROM lake_slice_grants WHERE project_id = ? AND token_hash = ?`
      )
      .get(input.projectId, input.tokenHash)
    return row ? parseLakeSliceGrantRow(row as Record<string, unknown>) : null
  }

  async listLive(input: ListLiveLakeSlicesInput): Promise<readonly LakeSliceRecord[]> {
    const rows = this.db
      .query(
        `SELECT ${SLICE_COLUMNS} FROM lake_slices
         WHERE project_id = ? AND ${LIVE_UNTIL} > ? ORDER BY created_at`
      )
      .all(input.projectId, input.liveAfter.toISOString())
    return rows.map((row) => parseLakeSliceRow(row as Record<string, unknown>))
  }

  async deleteExpired(input: DeleteExpiredLakeSlicesInput): Promise<number> {
    const before = input.before.toISOString()
    return this.db.transaction(() => {
      const ids = this.db
        .query(
          `SELECT id FROM lake_slices WHERE project_id = ? AND ${LIVE_UNTIL} <= ?
           ORDER BY ${LIVE_UNTIL} LIMIT ?`
        )
        .all(input.projectId, before, input.limit) as { id: string }[]
      for (const { id } of ids) {
        this.db
          .query("DELETE FROM lake_slice_grants WHERE project_id = ? AND slice_id = ?")
          .run(input.projectId, id)
        this.db
          .query("DELETE FROM lake_slices WHERE project_id = ? AND id = ?")
          .run(input.projectId, id)
      }
      this.db
        .query("DELETE FROM lake_slice_grants WHERE project_id = ? AND expires_at < ?")
        .run(input.projectId, before)
      return ids.length
    })()
  }
}
