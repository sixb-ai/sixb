import type { FileRef } from "../../blob-storage"

/**
 * One download URL issued by `blobs.createDownloadUrl()`. Each call issues its own grant, so URLs
 * for the same file expire and are revoked independently.
 */
export interface FileDownloadGrantRecord {
  readonly id: string
  readonly projectId: string
  /** SHA-256 hex of the URL token. The token itself is never stored. */
  readonly tokenHash: string
  /** The file the URL serves, without `logicalPath`: serving the bytes does not need it. */
  readonly file: FileRef
  /** The execution that issued the URL, so an exposure can be traced back to its cause. */
  readonly executionId: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
}

export interface FindFileDownloadGrantInput {
  readonly projectId: string
  readonly tokenHash: string
}

export interface RevokeFileDownloadGrantInput {
  readonly projectId: string
  readonly id: string
  readonly revokedAt: Date
}

export interface DeleteExpiredFileDownloadGrantsInput {
  readonly projectId: string
  readonly expiredBefore: Date
  readonly limit: number
}

/** Persistence only: token generation, expiry, and revocation checks live in Core. */
export interface FileDownloadGrantStorage {
  /** `(projectId, id)` and `(projectId, tokenHash)` are each unique. */
  create(record: FileDownloadGrantRecord): Promise<void>
  /** Returns expired and revoked grants too; the caller decides whether one still serves. */
  findByTokenHash(input: FindFileDownloadGrantInput): Promise<FileDownloadGrantRecord | null>
  /** Keeps the first revocation. Returns the grant, or `null` when it does not exist. */
  revoke(input: RevokeFileDownloadGrantInput): Promise<FileDownloadGrantRecord | null>
  /** Deletes up to `limit` grants that expired before `expiredBefore`, and returns the count. */
  deleteExpired(input: DeleteExpiredFileDownloadGrantsInput): Promise<number>
}
