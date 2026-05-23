import { AuthStorageError } from "../errors"
import type { AuthSessionStore, CreateAuthSessionInput, SessionRecord } from "../types"
import type { AuthStorageState } from "./shared"
import {
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  createSessionRecord,
  isActiveSession,
  revokeActiveSessionsForUser,
  sessionKey,
} from "./shared"

export class InMemoryAuthSessionStore implements AuthSessionStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateAuthSessionInput): Promise<SessionRecord> {
    return cloneRecord(createSessionRecord(this.state, input))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<SessionRecord | null> {
    const record = this.state.sessions.get(sessionKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async getActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const sessions = [...this.state.sessions.values()]
      .filter((session) => session.projectId === params.projectId)
      .filter((session) => session.userId === params.userId)
      .filter((session) => session.audience === params.audience)
      .filter((session) => isActiveSession(session, params.now))
      .sort((a, b) => compareByCreatedAt(a, b, "desc"))

    return cloneOptionalRecord(sessions[0] ?? null)
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly audience: string
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const session = this.state.sessions.get(sessionKey(params.projectId, params.id))
    if (
      !session ||
      session.audience !== params.audience ||
      session.tokenHash !== params.tokenHash ||
      !isActiveSession(session, params.now)
    ) {
      return null
    }

    return cloneRecord(session)
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<SessionRecord> {
    const key = sessionKey(params.projectId, params.id)
    const existing = this.state.sessions.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_session",
        `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: SessionRecord = {
      ...existing,
      revokedAt: cloneDate(params.revokedAt),
    }
    this.state.sessions.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async revokeActiveForUser(params: {
    readonly projectId: string
    readonly userId: string
    readonly audience?: string
    readonly revokedAt: Date
  }): Promise<readonly SessionRecord[]> {
    return revokeActiveSessionsForUser(
      this.state,
      params.projectId,
      params.userId,
      params.revokedAt,
      params.audience
    ).map(cloneRecord)
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastSeenAt: Date
  }): Promise<SessionRecord> {
    const key = sessionKey(params.projectId, params.id)
    const existing = this.state.sessions.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_session",
        `[Sixb] Session '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: SessionRecord = {
      ...existing,
      lastSeenAt: cloneDate(params.lastSeenAt),
    }
    this.state.sessions.set(key, cloneRecord(next))
    return cloneRecord(next)
  }
}
