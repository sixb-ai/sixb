import { randomUUID } from "node:crypto"
import type { FileUploadSession } from "./types"

export const DEFAULT_FILE_UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000
export const DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS = 15 * 60 * 1000

export function createUploadExpiresAt(now = Date.now()): Date {
  return new Date(now + DEFAULT_FILE_UPLOAD_SESSION_TTL_MS)
}

export function createFileUploadId(): string {
  return `upload_${randomUUID().replaceAll("-", "")}`
}

export function isFileUploadSessionExpired(
  session: FileUploadSession,
  nowMs = Date.now()
): boolean {
  return session.status === "pending" && session.expiresAt.getTime() <= nowMs
}

export function shouldDeleteFileUploadSession(session: FileUploadSession, nowMs: number): boolean {
  if (isFileUploadSessionExpired(session, nowMs)) {
    return true
  }

  return isTerminalFileUploadSessionExpired(session, nowMs)
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
