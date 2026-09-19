import type { Principal } from "../../auth"
import type { FileRef, SignedBlobUploadPart } from "../../blob-storage"
import { FileUploadSessionError } from "./errors"
import type {
  CreateFileUploadSessionInput,
  FileUploadSession,
  FileUploadSessionStore,
  FileUploadStatus,
  FileUploadStrategy,
} from "./types"
import {
  createFileUploadId,
  isFileUploadSessionExpired,
  isTerminalFileUploadSessionExpired,
  principalKey,
} from "./utils"

export { fileUploadSessionReapAt } from "./utils"

/** Database-specific row access used by the shared upload session state machine. */
export interface FileUploadSessionPersistence {
  now(): Promise<Date>
  /** Returns false when the id already exists. */
  insert(session: FileUploadSession): Promise<boolean>
  /** Inside `transaction`, must lock the row until the transaction ends. */
  get(uploadId: string): Promise<FileUploadSession | null>
  update(session: FileUploadSession): Promise<void>
  /** `pending`, holding a provider upload, `expires_at <= now`; oldest expiry first. */
  listAbandoned(now: Date, limit: number): Promise<readonly FileUploadSession[]>
  /** Deletes rows whose persisted `fileUploadSessionReapAt` is `<= now`. */
  deleteReapable(now: Date): Promise<number>
}

/** Transaction and lock boundary supplied by a concrete durable storage provider. */
export interface FileUploadSessionPersistenceBackend {
  read<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T>
  transaction<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T>
}

/**
 * Shared durable implementation of the upload session lifecycle. Concrete providers own SQL,
 * transactions and database time; every transition and retention rule lives here so SQLite,
 * PostgreSQL and the in-memory reference cannot drift semantically.
 */
export class DurableFileUploadSessions implements FileUploadSessionStore {
  constructor(private readonly backend: FileUploadSessionPersistenceBackend) {}

  async create(input: CreateFileUploadSessionInput): Promise<FileUploadSession> {
    return this.backend.transaction(async (persistence) => {
      const session: FileUploadSession = {
        id: input.id ?? createFileUploadId(),
        projectId: input.projectId,
        principalKey: principalKey(input.principal),
        strategy: input.strategy,
        status: "pending",
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        ...(input.logicalPath === undefined ? {} : { logicalPath: input.logicalPath }),
        ...(input.expectedSizeBytes === undefined
          ? {}
          : { expectedSizeBytes: input.expectedSizeBytes }),
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
        ...(input.providerUpload === undefined ? {} : { providerUpload: input.providerUpload }),
        signedParts: [],
        createdAt: await persistence.now(),
        expiresAt: input.expiresAt,
      }

      if (!(await persistence.insert(session))) {
        throw new Error(`[Sixb] File upload session '${session.id}' already exists.`)
      }
      return session
    })
  }

  async getForPrincipal(uploadId: string, principal: Principal): Promise<FileUploadSession> {
    return this.backend.read(async (persistence) => {
      const session = await persistence.get(uploadId)
      if (!session || session.principalKey !== principalKey(principal)) {
        throw new FileUploadSessionError("not_found", "File upload session not found.")
      }

      const nowMs = (await persistence.now()).getTime()
      if (isFileUploadSessionExpired(session, nowMs)) {
        throw new FileUploadSessionError("expired", "File upload session has expired.")
      }
      if (isTerminalFileUploadSessionExpired(session, nowMs)) {
        throw new FileUploadSessionError("not_found", "File upload session not found.")
      }
      return session
    })
  }

  markUploaded(uploadId: string, fileRef: FileRef): Promise<FileUploadSession> {
    return this.transition(uploadId, false, (session) => ({ ...session, fileRef }))
  }

  addSignedPart(uploadId: string, part: SignedBlobUploadPart): Promise<FileUploadSession> {
    return this.transition(uploadId, false, (session) => ({
      ...session,
      signedParts: [
        ...session.signedParts.filter((candidate) => candidate.partNumber !== part.partNumber),
        part,
      ].sort((left, right) => left.partNumber - right.partNumber),
    }))
  }

  complete(uploadId: string, fileRef: FileRef): Promise<FileUploadSession> {
    return this.transition(uploadId, false, (session, now) => ({
      ...session,
      status: "completed",
      fileRef,
      completedAt: now,
    }))
  }

  abort(uploadId: string): Promise<FileUploadSession> {
    return this.transition(uploadId, true, (session, now) => ({
      ...session,
      status: "aborted",
      abortedAt: now,
    }))
  }

  async listAbandoned(now: Date, limit: number): Promise<readonly FileUploadSession[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("[Sixb] File upload session listAbandoned limit must be a positive integer.")
    }
    return this.backend.read((persistence) => persistence.listAbandoned(now, limit))
  }

  async cleanupExpired(now?: Date): Promise<number> {
    return this.backend.transaction(async (persistence) =>
      persistence.deleteReapable(now ?? (await persistence.now()))
    )
  }

  private transition(
    uploadId: string,
    allowExpired: boolean,
    next: (session: FileUploadSession, now: Date) => FileUploadSession
  ): Promise<FileUploadSession> {
    return this.backend.transaction(async (persistence) => {
      const session = await persistence.get(uploadId)
      if (!session) {
        throw new FileUploadSessionError("not_found", "File upload session not found.")
      }
      if (session.status !== "pending") {
        throw new FileUploadSessionError(
          session.status === "completed" ? "already_completed" : "already_aborted",
          `File upload session is already ${session.status}.`
        )
      }

      const now = await persistence.now()
      if (!allowExpired && isFileUploadSessionExpired(session, now.getTime())) {
        throw new FileUploadSessionError("expired", "File upload session has expired.")
      }

      const updated = next(session, now)
      await persistence.update(updated)
      return updated
    })
  }
}

const STRATEGIES: readonly FileUploadStrategy[] = ["server", "direct-put", "multipart"]
const STATUSES: readonly FileUploadStatus[] = ["pending", "completed", "aborted"]

/**
 * Rebuilds a session from a provider row. JSON columns may arrive parsed (jsonb) or as text
 * (SQLite); nested `expiresAt` values are revived and every other nested field passes through,
 * so blob providers can extend `providerUpload` without a migration. Fails closed on corruption.
 */
export function parseFileUploadSessionRow(row: {
  readonly [column: string]: unknown
}): FileUploadSession {
  const id = text(row.id, "id", String(row.id))
  const strategy = text(row.strategy, "strategy", id) as FileUploadStrategy
  const status = text(row.status, "status", id) as FileUploadStatus
  if (!STRATEGIES.includes(strategy)) throw corrupt(id, `unknown strategy '${strategy}'`)
  if (!STATUSES.includes(status)) throw corrupt(id, `unknown status '${status}'`)

  const providerUpload = json(row.providerUpload)
  const fileRef = json(row.fileRef)
  const signedParts = json(row.signedParts)
  if (!Array.isArray(signedParts)) throw corrupt(id, "signedParts is not an array")

  const optional = <T>(key: string, value: T | null | undefined) =>
    value === null || value === undefined ? {} : { [key]: value }

  return {
    id,
    projectId: text(row.projectId, "projectId", id),
    principalKey: text(row.principalKey, "principalKey", id),
    strategy,
    status,
    ...optional("fileName", row.fileName as string | null),
    ...optional("mediaType", row.mediaType as string | null),
    ...optional("logicalPath", row.logicalPath as string | null),
    ...optional(
      "expectedSizeBytes",
      row.expectedSizeBytes === null || row.expectedSizeBytes === undefined
        ? null
        : Number(row.expectedSizeBytes)
    ),
    ...optional("expectedDigest", row.expectedDigest as string | null),
    ...optional(
      "providerUpload",
      providerUpload === null ? null : withExpiresAt(providerUpload, id)
    ),
    signedParts: signedParts.map((part) => withExpiresAt(part, id)) as SignedBlobUploadPart[],
    ...optional("fileRef", fileRef as FileRef | null),
    createdAt: date(row.createdAt, "createdAt", id),
    expiresAt: date(row.expiresAt, "expiresAt", id),
    ...optional(
      "completedAt",
      row.completedAt == null ? null : date(row.completedAt, "completedAt", id)
    ),
    ...optional("abortedAt", row.abortedAt == null ? null : date(row.abortedAt, "abortedAt", id)),
  } as FileUploadSession
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : (value ?? null)
}

function withExpiresAt<T>(value: unknown, id: string): T {
  if (typeof value !== "object" || value === null)
    throw corrupt(id, "nested record is not an object")
  const record = value as Record<string, unknown>
  return { ...record, expiresAt: date(record.expiresAt, "nested expiresAt", id) } as T
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
  return new Error(`[Sixb] Stored file upload session '${id}' is invalid: ${reason}.`)
}
