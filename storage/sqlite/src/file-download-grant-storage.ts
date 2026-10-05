import type { Database } from "bun:sqlite"
import { parseFileDownloadGrantRow } from "@sixb/core/internal/storage"
import type {
  DeleteExpiredFileDownloadGrantsInput,
  FileDownloadGrantRecord,
  FileDownloadGrantStorage,
  FindFileDownloadGrantInput,
  RevokeFileDownloadGrantInput,
} from "@sixb/core/storage"
import type { SqliteStoreConnection } from "./transactions"

const GRANT_COLUMNS = `
  project_id AS projectId, id, token_hash AS tokenHash, file, execution_id AS executionId,
  created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt
`

export class SqliteFileDownloadGrantStorage implements FileDownloadGrantStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async create(record: FileDownloadGrantRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO file_download_grants (
          project_id, id, token_hash, file, execution_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.projectId,
        record.id,
        record.tokenHash,
        JSON.stringify(record.file),
        record.executionId,
        record.createdAt.toISOString(),
        record.expiresAt.toISOString()
      )
  }

  async findByTokenHash(
    input: FindFileDownloadGrantInput
  ): Promise<FileDownloadGrantRecord | null> {
    const row = this.db
      .query(
        `SELECT ${GRANT_COLUMNS} FROM file_download_grants WHERE project_id = ? AND token_hash = ?`
      )
      .get(input.projectId, input.tokenHash)
    return row ? parseFileDownloadGrantRow(row as Record<string, unknown>) : null
  }

  async revoke(input: RevokeFileDownloadGrantInput): Promise<FileDownloadGrantRecord | null> {
    const row = this.db
      .query(
        `UPDATE file_download_grants SET revoked_at = COALESCE(revoked_at, ?)
         WHERE project_id = ? AND id = ?
         RETURNING ${GRANT_COLUMNS}`
      )
      .get(input.revokedAt.toISOString(), input.projectId, input.id)
    return row ? parseFileDownloadGrantRow(row as Record<string, unknown>) : null
  }

  async deleteExpired(input: DeleteExpiredFileDownloadGrantsInput): Promise<number> {
    return this.db
      .query(
        `DELETE FROM file_download_grants WHERE rowid IN (
          SELECT rowid FROM file_download_grants
          WHERE project_id = ? AND expires_at < ?
          ORDER BY expires_at
          LIMIT ?
        )`
      )
      .run(input.projectId, input.expiredBefore.toISOString(), input.limit).changes
  }
}
