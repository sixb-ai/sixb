import type { Principal } from "../../auth"
import type { FileRef, SignedBlobUploadPart } from "../../blob-storage"
import { FileUploadSessionError } from "./errors"
import type {
  CreateFileUploadSessionInput,
  FileUploadSession,
  FileUploadSessionStore,
} from "./types"
import {
  createFileUploadId,
  isFileUploadSessionExpired,
  isTerminalFileUploadSessionExpired,
  principalKey,
  shouldDeleteFileUploadSession,
} from "./utils"

export type InMemoryFileUploadSessionsSnapshot = Map<string, FileUploadSession>

export class InMemoryFileUploadSessions implements FileUploadSessionStore {
  private readonly sessionsById = new Map<string, FileUploadSession>()

  snapshot(): InMemoryFileUploadSessionsSnapshot {
    return structuredClone(this.sessionsById)
  }

  restore(snapshot: InMemoryFileUploadSessionsSnapshot): void {
    this.sessionsById.clear()
    for (const [id, session] of snapshot) {
      this.sessionsById.set(id, structuredClone(session))
    }
  }

  async create(input: CreateFileUploadSessionInput): Promise<FileUploadSession> {
    await this.cleanupExpired()

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
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    }

    this.sessionsById.set(session.id, session)
    return session
  }

  async getForPrincipal(uploadId: string, principal: Principal): Promise<FileUploadSession> {
    const session = this.sessionsById.get(uploadId)
    if (!session || session.principalKey !== principalKey(principal)) {
      throw new FileUploadSessionError("File upload session not found.", 404)
    }

    const nowMs = Date.now()
    if (isFileUploadSessionExpired(session, nowMs)) {
      this.sessionsById.delete(uploadId)
      throw new FileUploadSessionError("File upload session has expired.", 410)
    }

    if (isTerminalFileUploadSessionExpired(session, nowMs)) {
      this.sessionsById.delete(uploadId)
      throw new FileUploadSessionError("File upload session not found.", 404)
    }

    return session
  }

  async markUploaded(uploadId: string, fileRef: FileRef): Promise<FileUploadSession> {
    const session = this.requirePending(uploadId)
    const updated = {
      ...session,
      fileRef,
    }
    this.sessionsById.set(uploadId, updated)
    return updated
  }

  async addSignedPart(uploadId: string, part: SignedBlobUploadPart): Promise<FileUploadSession> {
    const session = this.requirePending(uploadId)
    const updated = {
      ...session,
      signedParts: [
        ...session.signedParts.filter((candidate) => candidate.partNumber !== part.partNumber),
        part,
      ].sort((left, right) => left.partNumber - right.partNumber),
    }
    this.sessionsById.set(uploadId, updated)
    return updated
  }

  async complete(uploadId: string, fileRef: FileRef): Promise<FileUploadSession> {
    const session = this.requirePending(uploadId)
    const updated = {
      ...session,
      status: "completed" as const,
      fileRef,
      completedAt: new Date(),
    }
    this.sessionsById.set(uploadId, updated)
    return updated
  }

  async abort(uploadId: string): Promise<FileUploadSession> {
    const session = this.requirePending(uploadId)
    const updated = {
      ...session,
      status: "aborted" as const,
      abortedAt: new Date(),
    }
    this.sessionsById.set(uploadId, updated)
    return updated
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    let deleted = 0
    for (const [id, session] of this.sessionsById) {
      if (shouldDeleteFileUploadSession(session, now.getTime())) {
        this.sessionsById.delete(id)
        deleted += 1
      }
    }

    return deleted
  }

  private requirePending(uploadId: string): FileUploadSession {
    const session = this.sessionsById.get(uploadId)
    if (!session) {
      throw new FileUploadSessionError("File upload session not found.", 404)
    }

    if (session.status !== "pending") {
      throw new FileUploadSessionError(`File upload session is already ${session.status}.`, 409)
    }

    return session
  }
}
