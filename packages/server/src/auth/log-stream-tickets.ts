import { randomBytes } from "node:crypto"
import type { AuthorizationContext } from "@sixb/core"

export const LOG_STREAM_TICKET_PROTOCOL_PREFIX = "sixb.logs.ticket."
const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_TICKETS = 10_000

interface StoredLogStreamTicket {
  readonly authz: AuthorizationContext | null
  readonly expiresAtMs: number
}

export interface IssuedLogStreamTicket {
  /** Complete WebSocket subprotocol value; never put it in a URL. */
  readonly ticket: string
  readonly expiresAt: string
}

export interface ConsumedLogStreamTicket {
  readonly ticket: string
  readonly authz: AuthorizationContext | null
}

/**
 * Process-local, bounded store for short-lived, single-use log stream tickets.
 * A ticket transfers an already-authorized HTTP identity into one WebSocket
 * handshake without exposing a durable bearer credential in the URL.
 */
export class LogStreamTicketStore {
  private readonly tickets = new Map<string, StoredLogStreamTicket>()

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxTickets = DEFAULT_MAX_TICKETS
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("log stream ticket ttlMs must be a positive safe integer")
    }
    if (!Number.isSafeInteger(maxTickets) || maxTickets <= 0) {
      throw new Error("log stream ticket maxTickets must be a positive safe integer")
    }
  }

  issue(authz: AuthorizationContext | null): IssuedLogStreamTicket {
    const now = Date.now()
    this.prune(now)
    if (this.tickets.size >= this.maxTickets) {
      throw new Error("Too many outstanding log stream tickets; retry shortly")
    }

    const ticket = `${LOG_STREAM_TICKET_PROTOCOL_PREFIX}${randomBytes(32).toString("base64url")}`
    const expiresAtMs = now + this.ttlMs
    this.tickets.set(ticket, { authz, expiresAtMs })
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consume(request: Request): ConsumedLogStreamTicket | null {
    const ticket = extractLogStreamTicketProtocol(request.headers.get("sec-websocket-protocol"))
    if (!ticket) {
      return null
    }

    const stored = this.tickets.get(ticket)
    // Delete before inspecting expiry so every known ticket is single-use,
    // including a ticket racing its expiry boundary.
    if (stored) {
      this.tickets.delete(ticket)
    }
    if (!stored || stored.expiresAtMs <= Date.now()) {
      return null
    }

    return { ticket, authz: stored.authz }
  }

  private prune(now: number): void {
    for (const [ticket, stored] of this.tickets) {
      if (stored.expiresAtMs <= now) {
        this.tickets.delete(ticket)
      }
    }
  }
}

export function extractLogStreamTicketProtocol(header: string | null): string | null {
  if (!header) {
    return null
  }

  for (const protocol of header.split(",")) {
    const candidate = protocol.trim()
    if (candidate.startsWith(LOG_STREAM_TICKET_PROTOCOL_PREFIX)) {
      return candidate
    }
  }
  return null
}

export function isLogStreamRequest(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/ws/logs"
}
