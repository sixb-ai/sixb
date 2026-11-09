import type { SharedSessionContext } from "@sixb/core/internal/shares"
import type { SharedAccessBoundary } from "../../auth/shared-access"
import { wsSharedSession, wsStateKey } from "../../utils/ws"

/**
 * How long a shared link's socket trusts its session before reading it again: on a timer, so a
 * socket that only listens closes too, and on its next message past that.
 */
export const SHARED_SOCKET_RECHECK_MS = 10_000

/**
 * The close code of a socket whose shared link ended: revoked, expired, or left idle. The client
 * stops reconnecting on it (`SHARED_ACCESS_ENDED_CLOSE_CODE` in `@sixb/client`).
 */
export const SHARED_ACCESS_ENDED_CLOSE_CODE = 4401

/** A socket closed because its session could not be read: the client reconnects. */
const UNREADABLE_SESSION_CLOSE_CODE = 1011

/** A socket, as far as watching it goes: closing it. */
export interface ClosableSocket {
  close(code?: number, reason?: string): void
}

interface Watch {
  /** The session as last read; null once it ended. */
  current: Promise<SharedSessionContext | null>
  checkedAt: number
  /** The name the visitor gave, as last read: a change is passed on to `onRenamed`. */
  name: string | undefined
  readonly timer: ReturnType<typeof setInterval>
  readonly onRenamed: (() => void) | undefined
}

/**
 * The sockets shared links' sessions opened, each kept open only while its session holds.
 *
 * The upgrade proved the session once, as any request does, and the socket's SDK keeps that
 * authority. A link revoked or a session expired since would go unnoticed, so each socket reads its
 * session again, by its id, at most every {@link SHARED_SOCKET_RECHECK_MS}, and is closed with
 * {@link SHARED_ACCESS_ENDED_CLOSE_CODE} once it ended. Reading it renews nothing: only a visitor's
 * own requests keep their session from idling out.
 */
export class SharedSockets {
  private readonly watches = new WeakMap<object, Watch>()
  /**
   * The open sockets of each session, read again at once when its visitor gives a name. Keyed by
   * `wsStateKey`: Elysia hands each handler a wrapper of its own around the one raw socket.
   */
  private readonly sockets = new Map<string, Map<object, ClosableSocket>>()

  constructor(private readonly boundary: SharedAccessBoundary) {
    // A name given through this server reaches its sockets at once; through another, at the next
    // read, within SHARED_SOCKET_RECHECK_MS.
    boundary.onGuestNamed((sessionId) => {
      for (const ws of this.sockets.get(sessionId)?.values() ?? []) {
        const watch = this.watches.get(wsStateKey(ws))
        const session = wsSharedSession(ws)
        if (watch && session) this.read(ws, watch, session)
      }
    })
  }

  /**
   * Starts watching a socket that a shared link's session opened; any other is left alone.
   * `onRenamed` hears when its visitor gives a name, or another, read from their session.
   */
  open(ws: ClosableSocket, onRenamed?: () => void): void {
    const session = wsSharedSession(ws)
    if (!session) return

    const watch: Watch = {
      current: Promise.resolve(session),
      checkedAt: Date.now(),
      name: session.guestName,
      timer: setInterval(() => void this.read(ws, watch, session), SHARED_SOCKET_RECHECK_MS),
      onRenamed,
    }
    this.watches.set(wsStateKey(ws), watch)

    const open = this.sockets.get(session.sessionId) ?? new Map<object, ClosableSocket>()
    this.sockets.set(session.sessionId, open.set(wsStateKey(ws), ws))
  }

  /**
   * Whether the socket may go on: false once the session that opened it ended, and the socket is
   * closing. Always true for a socket no shared link opened.
   */
  async holds(ws: ClosableSocket): Promise<boolean> {
    const watch = this.watches.get(wsStateKey(ws))
    const session = wsSharedSession(ws)
    if (!watch || !session) return true

    if (Date.now() - watch.checkedAt >= SHARED_SOCKET_RECHECK_MS) this.read(ws, watch, session)
    return (await watch.current) !== null
  }

  /** The session that opened the socket, as it is now: its visitor's name, once they gave one. */
  async session(ws: ClosableSocket): Promise<SharedSessionContext | null> {
    const watch = this.watches.get(wsStateKey(ws))
    const session = wsSharedSession(ws)
    if (!watch || !session) return null

    this.read(ws, watch, session)
    return watch.current
  }

  /** Stops watching a socket that closed. */
  close(ws: ClosableSocket): void {
    const key = wsStateKey(ws)
    const watch = this.watches.get(key)
    if (watch) clearInterval(watch.timer)
    this.watches.delete(key)

    const session = wsSharedSession(ws)
    const open = session ? this.sockets.get(session.sessionId) : undefined
    open?.delete(key)
    if (session && open?.size === 0) this.sockets.delete(session.sessionId)
  }

  private read(ws: ClosableSocket, watch: Watch, session: SharedSessionContext): void {
    watch.checkedAt = Date.now()
    watch.current = this.boundary.current(session).then(
      (current) => {
        if (!current) {
          this.end(ws, SHARED_ACCESS_ENDED_CLOSE_CODE, "Shared access ended")
          return current
        }

        if (current.guestName !== watch.name) {
          watch.name = current.guestName
          watch.onRenamed?.()
        }
        return current
      },
      (error: unknown) => {
        console.error("[SixbServer] A shared link's socket could not read its session:", error)
        this.end(ws, UNREADABLE_SESSION_CLOSE_CODE, "Shared access could not be checked")
        return null
      }
    )
  }

  private end(ws: ClosableSocket, code: number, reason: string): void {
    this.close(ws)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
