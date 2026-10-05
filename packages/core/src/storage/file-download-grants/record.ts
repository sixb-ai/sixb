import { isFileRef } from "../../blob-storage"
import type { FileDownloadGrantRecord } from "./types"

/**
 * Rebuilds a grant from a provider row with camelCase keys. `file` may arrive parsed (jsonb) or
 * as text (SQLite), and timestamps as `Date` or ISO text. Fails closed on corruption: a grant that
 * cannot be read must not serve a file.
 */
export function parseFileDownloadGrantRow(row: {
  readonly [column: string]: unknown
}): FileDownloadGrantRecord {
  const id = text(row.id, "id", String(row.id))
  const file = typeof row.file === "string" ? JSON.parse(row.file) : row.file
  if (!isFileRef(file)) throw corrupt(id, "file is not a file reference")

  return {
    id,
    projectId: text(row.projectId, "projectId", id),
    tokenHash: text(row.tokenHash, "tokenHash", id),
    file,
    executionId: text(row.executionId, "executionId", id),
    createdAt: date(row.createdAt, "createdAt", id),
    expiresAt: date(row.expiresAt, "expiresAt", id),
    ...(row.revokedAt == null ? {} : { revokedAt: date(row.revokedAt, "revokedAt", id) }),
  }
}

export function cloneFileDownloadGrantRecord(
  record: FileDownloadGrantRecord
): FileDownloadGrantRecord {
  return structuredClone(record)
}

function text(value: unknown, column: string, id: string): string {
  if (typeof value !== "string" || value.length === 0) throw corrupt(id, `${column} is not text`)
  return value
}

function date(value: unknown, column: string, id: string): Date {
  const parsed = value instanceof Date || typeof value === "string" ? new Date(value) : null
  if (!parsed || !Number.isFinite(parsed.getTime())) throw corrupt(id, `${column} is not a date`)
  return parsed
}

function corrupt(id: string, reason: string): Error {
  return new Error(`[Sixb] Stored file download grant '${id}' is invalid: ${reason}.`)
}
