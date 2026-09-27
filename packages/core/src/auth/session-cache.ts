import type { AuthSessionAudience } from "./audience"
import type { AuthenticatedAuthSession } from "./types"

interface SessionCacheEntry {
  readonly tokenHash: string
  readonly transport: "cookie" | "bearer"
  readonly audience: AuthSessionAudience
  readonly session: AuthenticatedAuthSession
  readonly expiresAtMs: number
}

export interface SessionCacheGetInput {
  readonly sessionId: string
  readonly tokenHash: string
  /** A cookie is only ever answered from a cookie entry, and a bearer token from a bearer entry. */
  readonly transport: "cookie" | "bearer"
  /** The browser audience a cookie was read for. Bearer sessions carry their own. */
  readonly audience?: AuthSessionAudience
  readonly nowMs: number
}

export interface SessionCacheSetInput {
  readonly sessionId: string
  readonly tokenHash: string
  readonly audience: AuthSessionAudience
  readonly nowMs: number
  readonly session: AuthenticatedAuthSession
  readonly sessionExpiresAtMs: number
  readonly sessionAbsoluteExpiresAtMs?: number
}

/**
 * Tiny in-process TTL cache for resolved auth sessions, keyed by session id.
 *
 * Every authenticated request resolves its session through the shared storage pool
 * (a session lookup plus user and group-membership reads). Under request bursts that
 * triples the pool pressure and, with a small pool, can starve the pool so the entire
 * API stalls. Caching the resolved result for a short TTL collapses those reads to one
 * per session per window.
 *
 * Safety: entries are pinned to the exact token hash, transport, and audience that produced them and
 * are never served past the session's rolling or absolute deadline. The short TTL bounds how long
 * a revoked session can linger; sign-out additionally invalidates eagerly via
 * {@link SessionCache.invalidate}.
 */
export class SessionCache {
  private readonly entries = new Map<string, SessionCacheEntry>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = 4096
  ) {}

  get(input: SessionCacheGetInput): AuthenticatedAuthSession | undefined {
    const entry = this.entries.get(input.sessionId)
    if (!entry) {
      return undefined
    }

    if (
      entry.expiresAtMs <= input.nowMs ||
      entry.tokenHash !== input.tokenHash ||
      entry.transport !== input.transport ||
      (input.audience !== undefined && entry.audience !== input.audience)
    ) {
      this.entries.delete(input.sessionId)
      return undefined
    }

    return entry.session
  }

  set(input: SessionCacheSetInput): void {
    // Never let a cached session outlive the real session, or a bearer session its access token.
    const bearer = input.session.session.bearer
    const expiresAtMs = Math.min(
      input.nowMs + this.ttlMs,
      input.sessionExpiresAtMs,
      input.sessionAbsoluteExpiresAtMs ?? Number.POSITIVE_INFINITY,
      bearer?.accessExpiresAt.getTime() ?? Number.POSITIVE_INFINITY
    )
    if (expiresAtMs <= input.nowMs) {
      return
    }

    // Re-insert so the freshest key sorts last for insertion-order LRU eviction.
    this.entries.delete(input.sessionId)
    this.entries.set(input.sessionId, {
      tokenHash: input.tokenHash,
      transport: bearer ? "bearer" : "cookie",
      audience: input.audience,
      session: input.session,
      expiresAtMs,
    })

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
  }

  invalidate(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /**
   * Drop every cached session for a user. Call this after a change that alters how
   * the user's session resolves (group reassignment, suspension) so the next request
   * re-reads storage instead of serving a stale principal.
   */
  invalidateUser(userId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.session.user.id === userId) {
        this.entries.delete(sessionId)
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
