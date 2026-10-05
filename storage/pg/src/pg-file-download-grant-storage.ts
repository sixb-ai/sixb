import { parseFileDownloadGrantRow } from "@sixb/core/internal/storage"
import type {
  DeleteExpiredFileDownloadGrantsInput,
  FileDownloadGrantRecord,
  FileDownloadGrantStorage,
  FindFileDownloadGrantInput,
  RevokeFileDownloadGrantInput,
} from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

export class PgFileDownloadGrantStorage implements FileDownloadGrantStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(record: FileDownloadGrantRecord): Promise<void> {
    await this.sql`
      INSERT INTO file_download_grants (
        project_id, id, token_hash, file, execution_id, created_at, expires_at
      ) VALUES (
        ${record.projectId}, ${record.id}, ${record.tokenHash},
        ${JSON.stringify(record.file)}::text::jsonb, ${record.executionId},
        ${record.createdAt}, ${record.expiresAt}
      )
    `
  }

  async findByTokenHash(
    input: FindFileDownloadGrantInput
  ): Promise<FileDownloadGrantRecord | null> {
    const [row] = await this.sql<PgFileDownloadGrantRow[]>`
      SELECT * FROM file_download_grants
      WHERE project_id = ${input.projectId} AND token_hash = ${input.tokenHash}
    `
    return row ? grantFromRow(row) : null
  }

  async revoke(input: RevokeFileDownloadGrantInput): Promise<FileDownloadGrantRecord | null> {
    const [row] = await this.sql<PgFileDownloadGrantRow[]>`
      UPDATE file_download_grants
      SET revoked_at = COALESCE(revoked_at, ${input.revokedAt})
      WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING *
    `
    return row ? grantFromRow(row) : null
  }

  async deleteExpired(input: DeleteExpiredFileDownloadGrantsInput): Promise<number> {
    const rows = await this.sql`
      DELETE FROM file_download_grants
      WHERE project_id = ${input.projectId} AND id IN (
        SELECT id FROM file_download_grants
        WHERE project_id = ${input.projectId} AND expires_at < ${input.expiredBefore}
        ORDER BY expires_at
        LIMIT ${input.limit}
      )
      RETURNING id
    `
    return rows.length
  }
}

interface PgFileDownloadGrantRow {
  readonly [column: string]: unknown
}

function grantFromRow(row: PgFileDownloadGrantRow): FileDownloadGrantRecord {
  return parseFileDownloadGrantRow({
    id: row.id,
    projectId: row.project_id,
    tokenHash: row.token_hash,
    file: row.file,
    executionId: row.execution_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  })
}
