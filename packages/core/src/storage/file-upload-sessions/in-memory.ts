import {
  DurableFileUploadSessions,
  type FileUploadSessionPersistence,
  type FileUploadSessionPersistenceBackend,
} from "./provider"
import type { CreateFileUploadSessionInput, FileUploadSession } from "./types"
import { isAbandonedFileUploadSession, shouldDeleteFileUploadSession } from "./utils"

export type InMemoryFileUploadSessionsSnapshot = Map<string, FileUploadSession>

/**
 * In-memory {@link FileUploadSessionStore}: the shared durable state machine over a Map.
 *
 * Sessions live only in this process's memory: they do not survive a restart and are not
 * shared across instances, so staged uploads need a single instance. `@sixb/pg` and
 * `@sixb/sqlite` provide durable stores. Reapable sessions are also swept on `create`,
 * because the `files.ts` fallback instance has no maintenance loop behind it.
 */
export class InMemoryFileUploadSessions extends DurableFileUploadSessions {
  private readonly sessionsById: Map<string, FileUploadSession>

  constructor() {
    const sessionsById = new Map<string, FileUploadSession>()
    super(new InMemoryFileUploadSessionBackend(sessionsById))
    this.sessionsById = sessionsById
  }

  override async create(input: CreateFileUploadSessionInput): Promise<FileUploadSession> {
    await this.cleanupExpired()
    return super.create(input)
  }

  snapshot(): InMemoryFileUploadSessionsSnapshot {
    return structuredClone(this.sessionsById)
  }

  restore(snapshot: InMemoryFileUploadSessionsSnapshot): void {
    this.sessionsById.clear()
    for (const [id, session] of snapshot) {
      this.sessionsById.set(id, structuredClone(session))
    }
  }
}

class InMemoryFileUploadSessionBackend implements FileUploadSessionPersistenceBackend {
  private readonly persistence: FileUploadSessionPersistence
  // Every await yields; chaining transactions keeps read-modify-write atomic.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(sessionsById: Map<string, FileUploadSession>) {
    this.persistence = new InMemoryFileUploadSessionPersistence(sessionsById)
  }

  read<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    return run(this.persistence)
  }

  transaction<T>(run: (persistence: FileUploadSessionPersistence) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => run(this.persistence))
    this.tail = result.catch(() => undefined)
    return result
  }
}

class InMemoryFileUploadSessionPersistence implements FileUploadSessionPersistence {
  constructor(private readonly sessionsById: Map<string, FileUploadSession>) {}

  async now(): Promise<Date> {
    return new Date()
  }

  async insert(session: FileUploadSession): Promise<boolean> {
    if (this.sessionsById.has(session.id)) return false
    this.sessionsById.set(session.id, session)
    return true
  }

  async get(uploadId: string): Promise<FileUploadSession | null> {
    return this.sessionsById.get(uploadId) ?? null
  }

  async update(session: FileUploadSession): Promise<void> {
    this.sessionsById.set(session.id, session)
  }

  async listAbandoned(now: Date, limit: number): Promise<readonly FileUploadSession[]> {
    return [...this.sessionsById.values()]
      .filter((session) => isAbandonedFileUploadSession(session, now.getTime()))
      .sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime())
      .slice(0, limit)
  }

  async deleteReapable(now: Date): Promise<number> {
    let deleted = 0
    for (const [id, session] of this.sessionsById) {
      if (shouldDeleteFileUploadSession(session, now.getTime())) {
        this.sessionsById.delete(id)
        deleted += 1
      }
    }
    return deleted
  }
}
