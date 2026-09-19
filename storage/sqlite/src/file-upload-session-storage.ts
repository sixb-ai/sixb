import type { Database } from "bun:sqlite"
import {
  DurableFileUploadSessions,
  type FileUploadSessionPersistence,
  type FileUploadSessionPersistenceBackend,
  fileUploadSessionReapAt,
  parseFileUploadSessionRow,
} from "@sixb/core/internal/file-upload-session-storage-provider"
import type { FileUploadSession, ListAbandonedFileUploadSessionsInput } from "@sixb/core/storage"
import { isUniqueConstraintError } from "./storage-errors"
import { runImmediateTransactionAsync, type SqliteStoreConnection } from "./transactions"

export class SqliteFileUploadSessionStorage extends DurableFileUploadSessions {
  constructor(connection: SqliteStoreConnection) {
    super(new SqliteFileUploadSessionBackend(connection.db))
  }
}

class SqliteFileUploadSessionBackend implements FileUploadSessionPersistenceBackend {
  private readonly persistence: FileUploadSessionPersistence
  // A concurrent runImmediateTransactionAsync joins the open transaction instead of waiting,
  // so an awaited read-modify-write would interleave. Chaining keeps each one atomic.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: Database) {
    this.persistence = new SqliteFileUploadSessionPersistence(db)
  }

  read<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    return run(this.persistence)
  }

  transaction<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    const result = this.tail.then(() =>
      runImmediateTransactionAsync(this.db, () => run(this.persistence))
    )
    this.tail = result.catch(() => undefined)
    return result
  }
}

class SqliteFileUploadSessionPersistence implements FileUploadSessionPersistence {
  constructor(private readonly db: Database) {}

  async now(): Promise<Date> {
    const row = this.db.query("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as {
      readonly now: string
    }
    return new Date(row.now)
  }

  async insert(session: FileUploadSession): Promise<boolean> {
    try {
      this.db
        .query(
          `INSERT INTO file_upload_sessions (
            id, project_id, principal_key, strategy, status, file_name, media_type, logical_path,
            expected_size_bytes, expected_digest, provider_upload, signed_parts, file_ref,
            created_at, expires_at, completed_at, aborted_at, reap_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.id,
          session.projectId,
          session.principalKey,
          session.strategy,
          session.status,
          session.fileName ?? null,
          session.mediaType ?? null,
          session.logicalPath ?? null,
          session.expectedSizeBytes ?? null,
          session.expectedDigest ?? null,
          ...mutableColumns(session)
        )
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  }

  async get(uploadId: string): Promise<FileUploadSession | null> {
    const row = this.db.query(`${SELECT_SESSION} WHERE id = ?`).get(uploadId)
    return row ? parseFileUploadSessionRow(row as Record<string, unknown>) : null
  }

  async update(session: FileUploadSession): Promise<void> {
    this.db
      .query(
        `UPDATE file_upload_sessions
         SET status = ?, provider_upload = ?, signed_parts = ?, file_ref = ?, created_at = ?,
             expires_at = ?, completed_at = ?, aborted_at = ?, reap_at = ?
         WHERE id = ?`
      )
      .run(session.status, ...mutableColumns(session), session.id)
  }

  async listAbandoned(
    input: ListAbandonedFileUploadSessionsInput
  ): Promise<readonly FileUploadSession[]> {
    const rows = this.db
      .query(
        `${SELECT_SESSION}
         WHERE project_id = ? AND status = 'pending' AND provider_upload IS NOT NULL
           AND expires_at <= ?
         ORDER BY expires_at, id
         LIMIT ?`
      )
      .all(input.projectId, input.now.toISOString(), input.limit)
    return rows.map((row) => parseFileUploadSessionRow(row as Record<string, unknown>))
  }

  async deleteReapable(now: Date): Promise<number> {
    return this.db
      .query("DELETE FROM file_upload_sessions WHERE reap_at IS NOT NULL AND reap_at <= ?")
      .run(now.toISOString()).changes
  }
}

const SELECT_SESSION = `
  SELECT id, project_id AS projectId, principal_key AS principalKey, strategy, status,
    file_name AS fileName, media_type AS mediaType, logical_path AS logicalPath,
    expected_size_bytes AS expectedSizeBytes, expected_digest AS expectedDigest,
    provider_upload AS providerUpload, signed_parts AS signedParts, file_ref AS fileRef,
    created_at AS createdAt, expires_at AS expiresAt, completed_at AS completedAt,
    aborted_at AS abortedAt
  FROM file_upload_sessions`

/** Columns a transition may change, in insert/update order after `expected_digest`/`status`. */
function mutableColumns(session: FileUploadSession) {
  return [
    session.providerUpload === undefined ? null : JSON.stringify(session.providerUpload),
    JSON.stringify(session.signedParts),
    session.fileRef === undefined ? null : JSON.stringify(session.fileRef),
    session.createdAt.toISOString(),
    session.expiresAt.toISOString(),
    session.completedAt?.toISOString() ?? null,
    session.abortedAt?.toISOString() ?? null,
    fileUploadSessionReapAt(session)?.toISOString() ?? null,
  ] as const
}
