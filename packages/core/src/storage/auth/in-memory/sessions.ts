import { AuthStorageError } from "../errors"
import type {
  AuthSessionStore,
  CreateAuthSessionInput,
  ListAuthSessionsInput,
  ListAuthSessionsResult,
  RotateSessionRefreshTokenResult,
  SessionRecord,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
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

  async listActiveByUserId(params: {
    readonly projectId: string
    readonly userId: string
    readonly now: Date
  }): Promise<readonly SessionRecord[]> {
    return [...this.state.sessions.values()]
      .filter((session) => session.projectId === params.projectId)
      .filter((session) => session.userId === params.userId)
      .filter((session) => isActiveSession(session, params.now))
      .sort((a, b) => {
        const activity =
          (b.lastSeenAt ?? b.createdAt).getTime() - (a.lastSeenAt ?? a.createdAt).getTime()
        if (activity !== 0) return activity
        const created = b.createdAt.getTime() - a.createdAt.getTime()
        return created !== 0 ? created : b.id.localeCompare(a.id)
      })
      .map(cloneRecord)
  }

  async listByUserId(params: ListAuthSessionsInput): Promise<ListAuthSessionsResult> {
    const before = params.before
    const offset = before?.skip ?? 0
    const sessions = [...this.state.sessions.values()]
      .filter((session) => session.projectId === params.projectId)
      .filter((session) => session.userId === params.userId)
      .filter((session) => !before || session.createdAt <= before.createdAt)
      .sort((a, b) => {
        const created = b.createdAt.getTime() - a.createdAt.getTime()
        if (created !== 0) return created
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })

    return {
      sessions: sessions.slice(offset, offset + params.limit).map(cloneRecord),
      hasMore: sessions.length > offset + params.limit,
    }
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const session = this.state.sessions.get(sessionKey(params.projectId, params.id))
    if (
      !session ||
      session.bearer ||
      session.tokenHash !== params.tokenHash ||
      !isActiveSession(session, params.now)
    ) {
      return null
    }

    return cloneRecord(session)
  }

  async findValidByAccessTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly now: Date
  }): Promise<SessionRecord | null> {
    const session = this.state.sessions.get(sessionKey(params.projectId, params.id))
    if (
      !session?.bearer ||
      session.tokenHash !== params.tokenHash ||
      session.bearer.accessExpiresAt <= params.now ||
      !isActiveSession(session, params.now)
    ) {
      return null
    }

    return cloneRecord(session)
  }

  async rotateRefreshToken(
    params: Parameters<AuthSessionStore["rotateRefreshToken"]>[0]
  ): Promise<RotateSessionRefreshTokenResult> {
    const key = sessionKey(params.projectId, params.id)
    const session = this.state.sessions.get(key)
    if (!session?.bearer || !isActiveSession(session, params.now)) {
      return { status: "invalid" }
    }

    const { bearer } = session
    const replacedRecently =
      bearer.previousRefreshTokenHash === params.refreshTokenHash &&
      bearer.refreshedAt !== undefined &&
      params.now.getTime() - bearer.refreshedAt.getTime() <= params.reuseGraceMs
    if (bearer.refreshTokenHash !== params.refreshTokenHash && !replacedRecently) {
      if (bearer.previousRefreshTokenHash !== params.refreshTokenHash) {
        return { status: "invalid" }
      }
      this.state.sessions.set(key, cloneRecord({ ...session, revokedAt: cloneDate(params.now) }))
      return { status: "reused" }
    }

    const requestedExpiresAt = session.absoluteExpiresAt
      ? new Date(Math.min(params.next.expiresAt.getTime(), session.absoluteExpiresAt.getTime()))
      : params.next.expiresAt
    const next: SessionRecord = {
      ...session,
      tokenHash: params.next.tokenHash,
      expiresAt: new Date(Math.max(session.expiresAt.getTime(), requestedExpiresAt.getTime())),
      lastSeenAt: cloneDate(params.now),
      bearer: {
        clientName: bearer.clientName,
        accessExpiresAt: cloneDate(params.next.accessExpiresAt),
        refreshTokenHash: params.next.refreshTokenHash,
        previousRefreshTokenHash: bearer.refreshTokenHash,
        refreshedAt: cloneDate(params.now),
      },
    }
    this.state.sessions.set(key, cloneRecord(next))
    return { status: "rotated", session: cloneRecord(next) }
  }

  async renewIfValid(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly now: Date
    readonly expiresAt: Date
  }): Promise<SessionRecord | null> {
    const key = sessionKey(params.projectId, params.id)
    const session = this.state.sessions.get(key)
    if (
      !session ||
      session.bearer ||
      session.tokenHash !== params.tokenHash ||
      !isActiveSession(session, params.now)
    ) {
      return null
    }

    const requestedExpiresAt = session.absoluteExpiresAt
      ? new Date(Math.min(params.expiresAt.getTime(), session.absoluteExpiresAt.getTime()))
      : params.expiresAt
    const next: SessionRecord = {
      ...session,
      expiresAt: new Date(Math.max(session.expiresAt.getTime(), requestedExpiresAt.getTime())),
      lastSeenAt: cloneDate(params.now),
    }
    this.state.sessions.set(key, cloneRecord(next))
    return cloneRecord(next)
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
    readonly revokedAt: Date
  }): Promise<readonly SessionRecord[]> {
    return revokeActiveSessionsForUser(
      this.state,
      params.projectId,
      params.userId,
      params.revokedAt
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
