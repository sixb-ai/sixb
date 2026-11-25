import type { DatasetVersionRef } from "../../lake-storage/types"
import type { LakeSliceGrantRecord, LakeSliceRecord } from "./types"

/**
 * Rebuilds a slice from a provider row with camelCase keys. Lists may arrive parsed (jsonb) or as
 * text (SQLite), and timestamps as `Date` or ISO text. Fails closed: a slice that cannot be read
 * serves no file.
 */
export function parseLakeSliceRow(row: { readonly [column: string]: unknown }): LakeSliceRecord {
  const id = text(row.id, "id", String(row.id))
  const versions = json(row.versions)
  const files = json(row.files)
  if (!isVersionRefs(versions)) throw corrupt(id, "versions are not dataset version references")
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw corrupt(id, "files are not paths")
  }

  return {
    id,
    projectId: text(row.projectId, "projectId", id),
    userId: text(row.userId, "userId", id),
    branch: text(row.branch, "branch", id),
    point: text(row.point, "point", id),
    versions: versions.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
    files: [...files],
    createdAt: date(row.createdAt, "createdAt", id),
    ...(row.lastTokenExpiresAt == null
      ? {}
      : { lastTokenExpiresAt: date(row.lastTokenExpiresAt, "lastTokenExpiresAt", id) }),
    ...(row.credentialHash == null
      ? {}
      : { credentialHash: text(row.credentialHash, "credentialHash", id) }),
    ...(row.credentialGroupIds == null
      ? {}
      : { credentialGroupIds: groupIds(json(row.credentialGroupIds), id) }),
    ...(row.receivedAt == null ? {} : { receivedAt: date(row.receivedAt, "receivedAt", id) }),
  }
}

export function parseLakeSliceGrantRow(row: {
  readonly [column: string]: unknown
}): LakeSliceGrantRecord {
  const id = text(row.id, "id", String(row.id))
  return {
    id,
    projectId: text(row.projectId, "projectId", id),
    tokenHash: text(row.tokenHash, "tokenHash", id),
    sliceId: text(row.sliceId, "sliceId", id),
    createdAt: date(row.createdAt, "createdAt", id),
    expiresAt: date(row.expiresAt, "expiresAt", id),
  }
}

function groupIds(value: unknown, id: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw corrupt(id, "credential groups are not group ids")
  }
  return [...value]
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

function isVersionRefs(value: unknown): value is readonly DatasetVersionRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.datasetId === "string" &&
        typeof item.versionId === "string"
    )
  )
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
  return new Error(`[Sixb] Stored lake slice '${id}' is invalid: ${reason}.`)
}
