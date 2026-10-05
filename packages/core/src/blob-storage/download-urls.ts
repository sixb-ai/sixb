import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { FileDownloadGrantRecord, FileDownloadGrantStorage, Storage } from "../storage"
import { BlobStorageError } from "./errors"
import type { BlobStorage, FileRef } from "./types"
import { isFileRef } from "./validation"

/**
 * Download URLs let a third party that cannot hold a Sixb session — a social network fetching
 * media to publish, for instance — read one file for a bounded time.
 *
 * Each URL carries a random token. Storage keeps only its SHA-256, with the file, the expiry, and
 * the execution that issued it. The API looks the token up on every request, so any process
 * sharing the storage can issue a URL, and a URL can be revoked before it expires.
 *
 * The API serves the bytes itself rather than redirecting to the blob provider: fetchers such as
 * TikTok refuse redirects and accept only hosts whose ownership the developer verified.
 */

/** Path prefix of the public route that serves download URLs. */
export const FILE_DOWNLOAD_ROUTE_PREFIX = "/api/files/downloads/"

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000
// SQLite compares ISO timestamps as text, which orders them correctly only for four-digit years.
const LATEST_EXPIRY_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)
/** 32 random bytes in base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface CreateFileDownloadUrlOptions {
  /** How long the URL stays valid. Defaults to one hour. */
  readonly expiresInMs?: number
}

export interface FileDownloadUrl {
  /** Pass to `blobs.revokeDownloadUrl()` to stop the URL before it expires. */
  readonly id: string
  readonly url: string
  readonly expiresAt: Date
}

/** What issuing and revoking need from the execution that asks. */
export interface FileDownloadUrlContext {
  readonly projectId: string
  readonly storage: Storage
  readonly blobStorage: BlobStorage
  readonly executionId: string
  readonly apiPublicOrigin: string | undefined
}

export async function createFileDownloadUrl(
  context: FileDownloadUrlContext,
  file: FileRef,
  options: CreateFileDownloadUrlOptions = {}
): Promise<FileDownloadUrl> {
  if (!isFileRef(file)) {
    throw new Error("[Sixb] blobs.createDownloadUrl() requires a valid file reference.")
  }
  const createdAt = new Date()
  const expiresAt = expiryFrom(createdAt, options.expiresInMs ?? DEFAULT_EXPIRY_MS)
  const grants = requireGrantStorage(context.storage)
  if (context.apiPublicOrigin === undefined) {
    throw new Error(
      "[Sixb] blobs.createDownloadUrl() needs the API's public origin. Set SIXB_API_PUBLIC_ORIGIN for the API and every worker."
    )
  }
  // Fail here, not when a third party fetches the URL minutes later and gets a bare 404.
  const stat = await context.blobStorage.stat(file.blobId)
  if (!stat || stat.digest !== file.digest || stat.sizeBytes !== file.sizeBytes) {
    throw new BlobStorageError(`[Sixb] No stored blob matches file '${file.blobId}'.`)
  }

  const token = randomBytes(32).toString("base64url")
  const { logicalPath: _logicalPath, ...served } = file
  const grant: FileDownloadGrantRecord = {
    id: `filedownload_${randomUUID()}`,
    projectId: context.projectId,
    tokenHash: hashToken(token),
    file: served,
    executionId: context.executionId,
    createdAt,
    expiresAt,
  }
  await grants.create(grant)

  return {
    id: grant.id,
    url: new URL(`${FILE_DOWNLOAD_ROUTE_PREFIX}${token}`, context.apiPublicOrigin).toString(),
    expiresAt: grant.expiresAt,
  }
}

export async function revokeFileDownloadUrl(
  context: FileDownloadUrlContext,
  id: string
): Promise<void> {
  const revoked = await requireGrantStorage(context.storage).revoke({
    projectId: context.projectId,
    id,
    revokedAt: new Date(),
  })
  if (!revoked) {
    throw new Error(`[Sixb] Download URL '${id}' does not exist.`)
  }
}

/** The file a token serves, or `null` when the token is unknown, expired, or revoked. */
export async function resolveFileDownload(
  host: { readonly id: string; readonly storage: Storage },
  token: string
): Promise<FileRef | null> {
  const grants = host.storage.fileDownloadGrants
  if (!grants || !TOKEN_PATTERN.test(token)) return null

  const grant = await grants.findByTokenHash({ projectId: host.id, tokenHash: hashToken(token) })
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= Date.now()) return null
  return grant.file
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function requireGrantStorage(storage: Storage): FileDownloadGrantStorage {
  if (!storage.fileDownloadGrants) {
    throw new Error("[Sixb] Download URLs require storage.fileDownloadGrants.")
  }
  return storage.fileDownloadGrants
}

function expiryFrom(createdAt: Date, expiresInMs: number): Date {
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new Error("[Sixb] expiresInMs must be a positive integer.")
  }
  const expiresAt = createdAt.getTime() + expiresInMs
  if (expiresAt > LATEST_EXPIRY_MS) {
    throw new Error("[Sixb] expiresInMs must end before the year 10000.")
  }
  return new Date(expiresAt)
}
