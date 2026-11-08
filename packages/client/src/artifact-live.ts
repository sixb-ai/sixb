/**
 * React-free transport for `/ws/artifacts`, where artifacts are edited live: one reconnecting
 * socket that carries the messages of every artifact a page holds. What each artifact does with
 * them, its Yjs document and its awareness, is the caller's: this only connects, says when the
 * server is ready for `join`, and hands each message on.
 */
import {
  ARTIFACT_LIVE_ROUTE,
  type ArtifactLiveClientMessage,
  type ArtifactLiveServerMessage,
} from "@sixb/core/artifacts/live"
import type { Client } from "./generated/client"
import {
  createReconnectingSocket,
  createSixbWebSocketUrl,
  type ReconnectingSocketState,
} from "./ws-socket"

/** The first wait before a reconnect, and the longest: it doubles until a connection is ready. */
const RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000

export interface ArtifactLiveSocketOptions {
  /** The client whose API and credential the socket uses. Defaults to the package's shared client. */
  readonly client?: Client
  readonly reconnectDelayMs?: number
  readonly maxReconnectDelayMs?: number
  /**
   * The server said `connected`: it takes `join` now. Called again after every reconnect, where
   * every artifact held has to join again.
   */
  readonly onConnected: () => void
  readonly onMessage: (message: ArtifactLiveServerMessage) => void
  readonly onStateChange?: (state: ReconnectingSocketState) => void
  readonly onError?: (message: string) => void
}

export interface ArtifactLiveSocket {
  /** Sends a message on the connection open now; false while there is none. */
  send(message: ArtifactLiveClientMessage): boolean
  close(): void
}

/** Opens `/ws/artifacts`, and keeps it open, reconnecting with backoff, until it is closed. */
export function createArtifactLiveSocket(options: ArtifactLiveSocketOptions): ArtifactLiveSocket {
  const socket = createReconnectingSocket({
    url: createSixbWebSocketUrl(ARTIFACT_LIVE_ROUTE, options.client?.getConfig().baseUrl),
    client: options.client,
    reconnectDelayMs: options.reconnectDelayMs ?? RECONNECT_DELAY_MS,
    maxReconnectDelayMs: options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS,
    readyWhen: (data) => parseArtifactLiveMessage(data)?.type === "connected",
    readyTimeoutMessage: "[SixbClient] The live artifacts socket did not say it was connected.",
    connectionErrorMessage: "[SixbClient] The live artifacts socket could not connect.",
    onMessage: (data) => {
      const message = parseArtifactLiveMessage(data)
      if (!message) return

      if (message.type === "connected") options.onConnected()
      else options.onMessage(message)
    },
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
  })

  return { send: (message) => socket.send(message), close: () => socket.close() }
}

const SERVER_MESSAGES: ReadonlySet<string> = new Set([
  "connected",
  "joined",
  "sync",
  "awareness",
  "status",
  "access",
  "left",
  "error",
])

/** A message the server sent; null for one that is not JSON, or of a type it never sends. */
function parseArtifactLiveMessage(data: unknown): ArtifactLiveServerMessage | null {
  if (typeof data !== "string") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const type = (parsed as { type?: unknown }).type
  return typeof type === "string" && SERVER_MESSAGES.has(type)
    ? (parsed as ArtifactLiveServerMessage)
    : null
}
