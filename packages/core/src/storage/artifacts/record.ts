import { isArtifactKind } from "../../artifacts/kinds"
import type { ArtifactOutline } from "../../artifacts/outline"
import type { ArtifactReference } from "../../artifacts/references"
import type { Principal } from "../../auth"
import { isFileRef } from "../../blob-storage"
import { type ArtifactLatestVersion, ArtifactStorageError } from "./errors"
import type {
  ArtifactFile,
  ArtifactFrameGrantRecord,
  ArtifactFrameTarget,
  ArtifactKind,
  ArtifactRecord,
  ArtifactVersionRecord,
} from "./types"

// Rows arrive from providers with camelCase keys. JSON columns may arrive parsed (jsonb) or as text
// (SQLite), and timestamps as `Date` or ISO text. A row that does not read back as a valid record
// fails closed rather than rendering something the store never held.

type Row = { readonly [column: string]: unknown }

export function parseArtifactRow(row: Row): ArtifactRecord {
  const id = text(row.id, "id", "artifact")
  const where = `artifact '${id}'`
  const kind = row.kind
  if (!isArtifactKind(kind)) throw corrupt(where, "kind is not an artifact kind")
  return {
    projectId: text(row.projectId, "projectId", where),
    id,
    kind,
    title: text(row.title, "title", where),
    owner: principal(row.ownerPrincipalType, row.ownerPrincipalId, "owner", where),
    latestVersion: positiveInteger(row.latestVersion, "latestVersion", where),
    createdAt: date(row.createdAt, "createdAt", where),
    updatedAt: date(row.updatedAt, "updatedAt", where),
  }
}

export function parseArtifactVersionRow(row: Row): ArtifactVersionRecord {
  const artifactId = text(row.artifactId, "artifactId", "artifact version")
  const version = positiveInteger(row.version, "version", `artifact '${artifactId}'`)
  const where = `artifact '${artifactId}' version ${version}`
  const originThreadId = row.originThreadId
  const originRunId = row.originRunId
  if ((originThreadId == null) !== (originRunId == null)) {
    throw corrupt(where, "origin needs both a thread and a run")
  }
  return {
    projectId: text(row.projectId, "projectId", where),
    artifactId,
    version,
    title: text(row.title, "title", where),
    entry: text(row.entry, "entry", where),
    files: files(json(row.files, "files", where), where),
    outline: outline(json(row.outline, "outline", where), where),
    references: references(json(row.refs, "refs", where), where),
    author: principal(row.authorPrincipalType, row.authorPrincipalId, "author", where),
    ...(originThreadId == null
      ? {}
      : {
          origin: {
            threadId: text(originThreadId, "originThreadId", where),
            runId: text(originRunId, "originRunId", where),
          },
        }),
    createdAt: date(row.createdAt, "createdAt", where),
  }
}

/** Targets are checked one by one: they decide what a frame may show from other artifacts. */
export function parseArtifactFrameGrantRow(row: Row): ArtifactFrameGrantRecord {
  const artifactId = text(row.artifactId, "artifactId", "artifact frame grant")
  const where = `frame grant for artifact '${artifactId}'`
  return {
    projectId: text(row.projectId, "projectId", where),
    tokenHash: text(row.tokenHash, "tokenHash", where),
    artifactId,
    version: positiveInteger(row.version, "version", where),
    targets: frameTargets(json(row.targets, "targets", where), where),
    createdAt: date(row.createdAt, "createdAt", where),
    expiresAt: date(row.expiresAt, "expiresAt", where),
  }
}

/** The errors every provider raises, with one wording. */
export const artifactStorageErrors = {
  exists: (id: string) =>
    new ArtifactStorageError("artifact_exists", `[Sixb] Artifact '${id}' already exists.`),
  notFound: (id: string) =>
    new ArtifactStorageError("artifact_not_found", `[Sixb] Artifact '${id}' was not found.`),
  kindMismatch: (id: string, kind: ArtifactKind, requested: ArtifactKind) =>
    new ArtifactStorageError(
      "artifact_kind_mismatch",
      `[Sixb] Artifact '${id}' is a ${kind}; it cannot take a ${requested} version.`
    ),
  moved: (id: string, baseVersion: number, latest: ArtifactLatestVersion) =>
    new ArtifactStorageError(
      "artifact_moved",
      `[Sixb] Artifact '${id}' is at version ${latest.version}, not version ${baseVersion}, which this publish was based on.`,
      latest
    ),
}

function files(value: unknown, where: string): ArtifactFile[] {
  if (!Array.isArray(value)) throw corrupt(where, "files is not a list")
  return value.map((entry) => {
    if (!isObject(entry) || typeof entry.path !== "string" || !isFileRef(entry.file)) {
      throw corrupt(where, "a file entry is not a path and a file reference")
    }
    return { path: entry.path, file: entry.file }
  })
}

function outline(value: unknown, where: string): ArtifactOutline {
  if (!isObject(value) || !isArtifactKind(value.kind)) {
    throw corrupt(where, "outline does not name an artifact kind")
  }
  return value as unknown as ArtifactOutline
}

function references(value: unknown, where: string): ArtifactReference[] {
  if (!Array.isArray(value)) throw corrupt(where, "references is not a list")
  return value.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.address !== "string" ||
      (entry.as !== "embed" && entry.as !== "link") ||
      typeof entry.at !== "string" ||
      !Number.isSafeInteger(entry.resolvedVersion) ||
      (entry.resolvedVersion as number) < 1
    ) {
      throw corrupt(where, "a reference is not an address, a verb, a place, and a version")
    }
    return {
      address: entry.address,
      as: entry.as,
      at: entry.at,
      resolvedVersion: entry.resolvedVersion as number,
    }
  })
}

function frameTargets(value: unknown, where: string): ArtifactFrameTarget[] {
  if (!Array.isArray(value)) throw corrupt(where, "targets is not a list")
  return value.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.address !== "string" ||
      typeof entry.artifactId !== "string" ||
      !Number.isSafeInteger(entry.version) ||
      (entry.version as number) < 1
    ) {
      throw corrupt(where, "a target is not an address, an artifact, and a version")
    }
    return {
      address: entry.address,
      artifactId: entry.artifactId,
      version: entry.version as number,
    }
  })
}

const PRINCIPAL_TYPES: ReadonlySet<string> = new Set(["user", "serviceAccount", "system"])

function principal(type: unknown, id: unknown, column: string, where: string): Principal {
  if (typeof type !== "string" || !PRINCIPAL_TYPES.has(type)) {
    throw corrupt(where, `${column} is not a principal`)
  }
  return { type: type as Principal["type"], id: text(id, column, where) }
}

function json(value: unknown, column: string, where: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    throw corrupt(where, `${column} is not JSON`)
  }
}

function text(value: unknown, column: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw corrupt(where, `${column} is not text`)
  return value
}

function positiveInteger(value: unknown, column: string, where: string): number {
  const number = typeof value === "bigint" ? Number(value) : value
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw corrupt(where, `${column} is not a positive integer`)
  }
  return number
}

function date(value: unknown, column: string, where: string): Date {
  const parsed = value instanceof Date || typeof value === "string" ? new Date(value) : null
  if (!parsed || !Number.isFinite(parsed.getTime())) throw corrupt(where, `${column} is not a date`)
  return parsed
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function corrupt(where: string, reason: string): Error {
  return new Error(`[Sixb] Stored ${where} is invalid: ${reason}.`)
}
