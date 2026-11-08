import { isArtifactKind } from "../../artifacts/kinds"
import { ARTIFACT_STATE_LIMITS } from "../../artifacts/limits"
import type { ArtifactOutline } from "../../artifacts/outline"
import type { ArtifactReference } from "../../artifacts/references"
import type { Principal } from "../../auth"
import { isFileRef } from "../../blob-storage"
import { type ArtifactLatestVersion, ArtifactStorageError } from "./errors"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactDocument,
  ArtifactFile,
  ArtifactFrameGrantRecord,
  ArtifactFrameTarget,
  ArtifactKind,
  ArtifactRecord,
  ArtifactRestorePointRecord,
  ArtifactStateEntry,
  ArtifactTurnWriteRecord,
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
    revision: positiveInteger(row.revision, "revision", where),
    createdAt: date(row.createdAt, "createdAt", where),
    updatedAt: date(row.updatedAt, "updatedAt", where),
    ...document(row.document, row.documentRevision, where),
  }
}

/** The artifact's Yjs document, when it keeps one, and the revision it holds. */
function document(
  value: unknown,
  revision: unknown,
  where: string
): { readonly document?: ArtifactDocument } {
  if ((value == null) !== (revision == null)) {
    throw corrupt(where, "document and documentRevision are not both set")
  }
  if (value == null) return {}
  const file = json(value, "document", where)
  if (!isFileRef(file)) throw corrupt(where, "document is not a file reference")
  return { document: { file, revision: positiveInteger(revision, "documentRevision", where) } }
}

export function parseArtifactVersionRow(row: Row): ArtifactVersionRecord {
  const artifactId = text(row.artifactId, "artifactId", "artifact version")
  const version = positiveInteger(row.version, "version", `artifact '${artifactId}'`)
  const where = `artifact '${artifactId}' version ${version}`
  return {
    projectId: text(row.projectId, "projectId", where),
    artifactId,
    version,
    revision: positiveInteger(row.revision, "revision", where),
    ...content(row, where),
    createdAt: date(row.createdAt, "createdAt", where),
    updatedAt: date(row.updatedAt, "updatedAt", where),
    ...frozen(row, where),
  }
}

/** When, and by whom, a version was created: both or neither. */
function frozen(row: Row, where: string) {
  if ((row.frozenAt == null) !== (row.frozenByPrincipalType == null)) {
    throw corrupt(where, "a frozen version names who froze it, and an open one does not")
  }
  if (row.frozenAt == null) return {}

  return {
    frozenAt: date(row.frozenAt, "frozenAt", where),
    frozenBy: principal(row.frozenByPrincipalType, row.frozenByPrincipalId, "frozenBy", where),
  }
}

export function parseArtifactRestorePointRow(row: Row): ArtifactRestorePointRecord {
  const artifactId = text(row.artifactId, "artifactId", "artifact restore point")
  const revision = positiveInteger(row.revision, "revision", `artifact '${artifactId}'`)
  const where = `restore point of artifact '${artifactId}' at revision ${revision}`
  const reason = row.reason
  if (reason !== "turn" && reason !== "restore")
    throw corrupt(where, "reason is not turn or restore")
  if ((reason === "turn") !== (row.turnRunId != null)) {
    throw corrupt(where, "a turn's restore point names its run, and only it does")
  }
  return {
    projectId: text(row.projectId, "projectId", where),
    artifactId,
    revision,
    version: positiveInteger(row.version, "version", where),
    frozen: flag(row.frozen, "frozen", where),
    ...content(row, where),
    updatedAt: date(row.updatedAt, "updatedAt", where),
    reason,
    ...(reason === "turn" ? { turnRunId: text(row.turnRunId, "turnRunId", where) } : {}),
    createdAt: date(row.createdAt, "createdAt", where),
  }
}

export function parseArtifactTurnWriteRow(row: Row): ArtifactTurnWriteRecord {
  const artifactId = text(row.artifactId, "artifactId", "artifact turn write")
  const where = `turn write to artifact '${artifactId}'`
  return {
    artifactId,
    created: flag(row.created, "created", where),
    revision: positiveInteger(row.revision, "revision", where),
    writes: positiveInteger(row.writes, "writes", where),
  }
}

/**
 * Whether a retry may undo a turn's writes to an artifact: nobody else changed it since the turn
 * began. Every change moves an artifact's revision by exactly one, so the turn's writes alone took
 * it from its restore point's revision, or from nothing when the turn created it, to `revision`;
 * a write, a version created, or a restore by anyone else between two of them leaves it further.
 * And the version the restore point held open must still be open: undoing never rewrites or
 * reopens a version someone created.
 */
export function turnUndoable(input: {
  readonly write: Pick<ArtifactTurnWriteRecord, "created" | "writes">
  /** The artifact's revision now. */
  readonly revision: number
  /** The turn's restore point; none for an artifact the turn created. */
  readonly point?: Pick<ArtifactRestorePointRecord, "revision" | "frozen">
  /** The version the restore point was taken of, as it is now; none when it is gone. */
  readonly target?: { readonly frozen: boolean }
}): boolean {
  const { write, revision, point, target } = input
  if (write.created) return revision === write.writes

  if (!point || !target) return false
  if (target.frozen && !point.frozen) return false

  return revision - point.revision === write.writes
}

/** What a version or a restore point holds, and who last wrote it from where. */
function content(row: Row, where: string) {
  const originThreadId = row.originThreadId
  const originRunId = row.originRunId
  if ((originThreadId == null) !== (originRunId == null)) {
    throw corrupt(where, "origin needs both a thread and a run")
  }
  return {
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
    revision: positiveInteger(row.revision, "revision", where),
    targets: frameTargets(json(row.targets, "targets", where), where),
    createdAt: date(row.createdAt, "createdAt", where),
    expiresAt: date(row.expiresAt, "expiresAt", where),
  }
}

export function parseArtifactBoardPreviewRow(row: Row): ArtifactBoardPreviewRecord {
  const renderKey = text(row.renderKey, "renderKey", "board preview")
  const where = `board preview '${renderKey}'`
  const theme = row.theme
  if (theme !== "light" && theme !== "dark") throw corrupt(where, "theme is not light or dark")
  const size = row.size
  if (size !== "full" && size !== "small") throw corrupt(where, "size is not full or small")
  const file = json(row.file, "file", where)
  if (!isFileRef(file)) throw corrupt(where, "file is not a file reference")
  return {
    projectId: text(row.projectId, "projectId", where),
    renderKey,
    theme,
    size,
    file,
    createdAt: date(row.createdAt, "createdAt", where),
  }
}

export function parseArtifactStateRow(row: Row): ArtifactStateEntry {
  const key = text(row.key, "key", "artifact state")
  const where = `artifact state '${key}'`
  const sizeBytes = Number(row.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw corrupt(where, "sizeBytes is not a byte count")
  }
  return {
    key,
    value: text(row.value, "value", where),
    sizeBytes,
    updatedAt: date(row.updatedAt, "updatedAt", where),
  }
}

/** A value's UTF-8 bytes, which a reader's state limits count. */
export function artifactStateBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Throws `artifact_state_full` when a value would take a reader past `ARTIFACT_STATE_LIMITS`.
 * `others` is what the reader keeps under every other key, so replacing a value counts once.
 */
export function checkArtifactStateWrite(input: {
  readonly key: string
  readonly valueBytes: number
  readonly others: { readonly keys: number; readonly bytes: number }
}): void {
  const limits = ARTIFACT_STATE_LIMITS
  if (input.valueBytes > limits.maxValueBytes) {
    throw artifactStorageErrors.stateFull(
      `[Sixb] '${input.key}' is ${kilobytes(input.valueBytes)}; a page keeps at most ${kilobytes(limits.maxValueBytes)} under one key.`
    )
  }
  if (input.others.keys + 1 > limits.maxKeys) {
    throw artifactStorageErrors.stateFull(
      `[Sixb] A page keeps at most ${limits.maxKeys} keys for each reader: delete one before keeping '${input.key}'.`
    )
  }
  if (input.others.bytes + input.valueBytes > limits.maxBytes) {
    throw artifactStorageErrors.stateFull(
      `[Sixb] A page keeps at most ${kilobytes(limits.maxBytes)} for each reader; '${input.key}' would take it to ${kilobytes(input.others.bytes + input.valueBytes)}.`
    )
  }
}

function kilobytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024).toLocaleString("en-US")} KB`
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
  moved: (id: string, baseRevision: number, latest: ArtifactLatestVersion) =>
    new ArtifactStorageError(
      "artifact_moved",
      `[Sixb] Artifact '${id}' changed since revision ${baseRevision}, which this was based on: it is at revision ${latest.revision}, version ${latest.version}${latest.frozenBy ? `, which ${latest.frozenBy.type} '${latest.frozenBy.id}' created` : ""}.`,
      latest
    ),
  restorePointNotFound: (id: string, revision: number) =>
    new ArtifactStorageError(
      "restore_point_not_found",
      `[Sixb] Artifact '${id}' keeps no restore point of revision ${revision}.`
    ),
  stateFull: (message: string) => new ArtifactStorageError("artifact_state_full", message),
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
      !(
        entry.version === "latest" ||
        (Number.isSafeInteger(entry.version) && (entry.version as number) >= 1)
      )
    ) {
      throw corrupt(where, "a target is not an address, an artifact, and a version")
    }
    return {
      address: entry.address,
      artifactId: entry.artifactId,
      version: entry.version as number | "latest",
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

/** A boolean, as Postgres returns it or as SQLite keeps it: 0 or 1. */
function flag(value: unknown, column: string, where: string): boolean {
  if (typeof value === "boolean") return value
  if (value === 0 || value === 1) return value === 1
  throw corrupt(where, `${column} is not true or false`)
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
