import {
  DurableFileUploadSessions,
  type FileUploadSessionPersistence,
  type FileUploadSessionPersistenceBackend,
  fileUploadSessionReapAt,
  parseFileUploadSessionRow,
} from "@sixb/core/internal/file-upload-session-storage-provider"
import type { FileUploadSession } from "@sixb/core/storage"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgFileUploadSessionStorage extends DurableFileUploadSessions {
  constructor(sql: PgStoreClient) {
    super(new PgFileUploadSessionBackend(sql))
  }
}

class PgFileUploadSessionBackend implements FileUploadSessionPersistenceBackend {
  constructor(private readonly sql: PgStoreClient) {}

  read<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    return run(new PgFileUploadSessionPersistence(this.sql, false))
  }

  transaction<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    return runPgTransaction(this.sql, (tx) => run(new PgFileUploadSessionPersistence(tx, true)))
  }
}

class PgFileUploadSessionPersistence implements FileUploadSessionPersistence {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly locking: boolean
  ) {}

  async now(): Promise<Date> {
    const [row] = await this.sql<{ readonly now: Date }[]>`SELECT clock_timestamp() AS now`
    if (!row) throw new Error("[SixbPg] Database clock returned no row.")
    return new Date(row.now)
  }

  async insert(session: FileUploadSession): Promise<boolean> {
    // A unique violation would abort the surrounding transaction; report the conflict instead.
    const rows = await this.sql`
      INSERT INTO file_upload_sessions (
        id, project_id, principal_key, strategy, status, file_name, media_type, logical_path,
        expected_size_bytes, expected_digest, provider_upload, signed_parts, file_ref,
        created_at, expires_at, completed_at, aborted_at, reap_at
      ) VALUES (
        ${session.id}, ${session.projectId}, ${session.principalKey}, ${session.strategy},
        ${session.status}, ${session.fileName ?? null}, ${session.mediaType ?? null},
        ${session.logicalPath ?? null}, ${session.expectedSizeBytes ?? null},
        ${session.expectedDigest ?? null}, ${jsonText(session.providerUpload)}::text::jsonb,
        ${JSON.stringify(session.signedParts)}::text::jsonb, ${jsonText(session.fileRef)}::text::jsonb,
        ${session.createdAt}, ${session.expiresAt}, ${session.completedAt ?? null},
        ${session.abortedAt ?? null}, ${fileUploadSessionReapAt(session)}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `
    return rows.length === 1
  }

  async get(uploadId: string): Promise<FileUploadSession | null> {
    const [row] = this.locking
      ? await this.sql<PgFileUploadSessionRow[]>`
          SELECT * FROM file_upload_sessions WHERE id = ${uploadId} FOR UPDATE
        `
      : await this.sql<PgFileUploadSessionRow[]>`
          SELECT * FROM file_upload_sessions WHERE id = ${uploadId}
        `
    return row ? sessionFromRow(row) : null
  }

  async update(session: FileUploadSession): Promise<void> {
    await this.sql`
      UPDATE file_upload_sessions
      SET status = ${session.status},
        provider_upload = ${jsonText(session.providerUpload)}::text::jsonb,
        signed_parts = ${JSON.stringify(session.signedParts)}::text::jsonb,
        file_ref = ${jsonText(session.fileRef)}::text::jsonb,
        created_at = ${session.createdAt},
        expires_at = ${session.expiresAt},
        completed_at = ${session.completedAt ?? null},
        aborted_at = ${session.abortedAt ?? null},
        reap_at = ${fileUploadSessionReapAt(session)}
      WHERE id = ${session.id}
    `
  }

  async listAbandoned(now: Date, limit: number): Promise<readonly FileUploadSession[]> {
    const rows = await this.sql<PgFileUploadSessionRow[]>`
      SELECT * FROM file_upload_sessions
      WHERE status = 'pending' AND provider_upload IS NOT NULL AND expires_at <= ${now}
      ORDER BY expires_at, id COLLATE "C"
      LIMIT ${limit}
    `
    return rows.map(sessionFromRow)
  }

  async deleteReapable(now: Date): Promise<number> {
    const rows = await this.sql`
      DELETE FROM file_upload_sessions
      WHERE reap_at IS NOT NULL AND reap_at <= ${now}
      RETURNING id
    `
    return rows.length
  }
}

interface PgFileUploadSessionRow {
  readonly [column: string]: unknown
}

function sessionFromRow(row: PgFileUploadSessionRow): FileUploadSession {
  return parseFileUploadSessionRow({
    id: row.id,
    projectId: row.project_id,
    principalKey: row.principal_key,
    strategy: row.strategy,
    status: row.status,
    fileName: row.file_name,
    mediaType: row.media_type,
    logicalPath: row.logical_path,
    expectedSizeBytes: row.expected_size_bytes,
    expectedDigest: row.expected_digest,
    providerUpload: row.provider_upload,
    signedParts: row.signed_parts,
    fileRef: row.file_ref,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    abortedAt: row.aborted_at,
  })
}

/** JSON text for a nullable jsonb column; always bind with the `::text::jsonb` double cast. */
function jsonText(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value)
}
