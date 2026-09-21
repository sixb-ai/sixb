import { randomUUID } from "node:crypto"
import type { Principal } from "../../auth"
import type { FileUploadSession } from "./types"

export const DEFAULT_FILE_UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000
export const DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS = 15 * 60 * 1000

export function createUploadExpiresAt(now = Date.now()): Date {
  return new Date(now + DEFAULT_FILE_UPLOAD_SESSION_TTL_MS)
}

export function createFileUploadId(): string {
  return `upload_${randomUUID().replaceAll("-", "")}`
}

export function principalKey(principal: Principal): string {
  return `${principal.type}:${principal.id}`
}

export function isFileUploadSessionExpired(
  session: FileUploadSession,
  nowMs = Date.now()
): boolean {
  return session.status === "pending" && session.expiresAt.getTime() <= nowMs
}

/** Expired, still `pending`, and holding a provider upload only `abortUpload` can release. */
export function isAbandonedFileUploadSession(
  session: FileUploadSession,
  nowMs = Date.now()
): boolean {
  return session.providerUpload !== undefined && isFileUploadSessionExpired(session, nowMs)
}

/**
 * When a session may be deleted, or null when only a state change can make it deletable.
 * This is the single retention rule: durable providers persist it as `reap_at` and delete
 * `reap_at <= now`, so SQL never restates it.
 */
export function fileUploadSessionReapAt(session: FileUploadSession): Date | null {
  if (session.status === "pending") {
    return session.providerUpload === undefined ? session.expiresAt : null
  }

  const terminalAt = session.completedAt ?? session.abortedAt
  return terminalAt
    ? new Date(terminalAt.getTime() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS)
    : null
}

export function shouldDeleteFileUploadSession(session: FileUploadSession, nowMs: number): boolean {
  const reapAt = fileUploadSessionReapAt(session)
  return reapAt !== null && reapAt.getTime() <= nowMs
}

export function isTerminalFileUploadSessionExpired(
  session: FileUploadSession,
  nowMs: number
): boolean {
  if (session.status === "pending") {
    return false
  }

  const terminalAt = session.completedAt ?? session.abortedAt
  if (!terminalAt) {
    return false
  }

  return terminalAt.getTime() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS <= nowMs
}
