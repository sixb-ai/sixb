import type { Principal } from "../../auth"
import type {
  BlobDigest,
  BlobUploadSession,
  FileRef,
  SignedBlobUploadPart,
} from "../../blob-storage"

export type FileUploadStrategy = "server" | "direct-put" | "multipart"
export type FileUploadStatus = "pending" | "completed" | "aborted"

export interface CreateFileUploadSessionInput {
  readonly id?: string
  readonly projectId: string
  readonly principal: Principal
  readonly strategy: FileUploadStrategy
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
  readonly expectedSizeBytes?: number
  readonly expectedDigest?: BlobDigest
  readonly expiresAt: Date
  readonly providerUpload?: BlobUploadSession
}

export interface FileUploadSession {
  readonly id: string
  readonly projectId: string
  readonly principalKey: string
  readonly strategy: FileUploadStrategy
  readonly status: FileUploadStatus
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
  readonly expectedSizeBytes?: number
  readonly expectedDigest?: BlobDigest
  readonly providerUpload?: BlobUploadSession
  readonly signedParts: readonly SignedBlobUploadPart[]
  readonly fileRef?: FileRef
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly completedAt?: Date
  readonly abortedAt?: Date
}

/**
 * State machine for a staged/direct-put upload session. A session is created
 * `pending`; `markUploaded` records the resolved {@link FileRef} but keeps the
 * session `pending` (non-terminal), while `complete` and `abort` move it to a
 * terminal `completed`/`aborted` state. Terminal sessions are retained briefly
 * (for idempotent retries) then reaped by `cleanupExpired`.
 */
export interface FileUploadSessionStore {
  create(input: CreateFileUploadSessionInput): Promise<FileUploadSession>
  getForPrincipal(uploadId: string, principal: Principal): Promise<FileUploadSession>
  markUploaded(uploadId: string, fileRef: FileRef): Promise<FileUploadSession>
  addSignedPart(uploadId: string, part: SignedBlobUploadPart): Promise<FileUploadSession>
  complete(uploadId: string, fileRef: FileRef): Promise<FileUploadSession>
  abort(uploadId: string): Promise<FileUploadSession>
  cleanupExpired(now?: Date): Promise<number>
}
