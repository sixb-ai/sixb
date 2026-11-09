/**
 * React-free reconnecting WebSocket transport shared by the event and agent-run streams.
 *
 * It owns the whole connection lifecycle — connect, send the subscribe frame, reconnect with
 * backoff, tear down — plus the connected/reconnecting/error state machine. Callers inject the URL,
 * a cursor-aware subscribe payload, and message handling, so each stream keeps its own wire
 * protocol while sharing one reconnection loop. React is an optional peer of `@sixb/client`;
 * nothing here may import it.
 */
import {
  getClientSessionAuthority,
  getClientSharedGrantId,
  SHARED_ACCESS_ENDED,
  SHARED_ACCESS_ENDED_CLOSE_CODE,
  SHARED_ACCESS_REALTIME_UNAVAILABLE,
} from "./client-authority"
import type { Client } from "./generated/client"
import { client as generatedClient } from "./generated/client.gen"
import { getSixbSessionAccessToken, SixbSessionEndedError } from "./session"

const DEFAULT_SIXB_API_BASE_URL = "http://localhost:3002"
const DEFAULT_RECONNECT_DELAY_MS = 1000
const DEFAULT_READY_TIMEOUT_MS = 10_000

export interface ReconnectingSocketState {
  readonly connected: boolean
  readonly reconnecting: boolean
  readonly error: string | null
}

/** Handed to `onMessage` so a stream-level error frame updates socket state + notifies the caller. */
export interface ReconnectingSocketErrorSink {
  reportError(message: string): void
}

export interface ReconnectingSocketOptions {
  readonly url: string
  /** The client whose credential the socket presents. Defaults to the package's shared client. */
  readonly client?: Client
  /**
   * The stream also serves a shared link's session: a shared client names its grant in the URL,
   * as file links do, and its session cookie is the credential. Any other stream refuses one.
   */
  readonly sharedAccess?: boolean
  /** Built before every connection; useful for one-shot WebSocket tickets. */
  readonly protocols?: () => readonly string[] | Promise<readonly string[]>
  /** Decide whether a failed async connection setup should be retried. */
  readonly shouldReconnectAfterSetupError?: (error: unknown) => boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /**
   * Doubles the wait before each reconnect after the first, from `reconnectDelayMs` up to this,
   * until a connection is ready again. Without it, every reconnect waits `reconnectDelayMs`.
   */
  readonly maxReconnectDelayMs?: number
  /**
   * Built fresh for each subscription so it can carry the latest resume cursor. A stream that
   * subscribes its own way, with messages of its own through `send`, has none.
   */
  readonly subscribeMessage?: () => unknown
  /**
   * Optional protocol-level readiness check. When provided, defer the subscribe
   * frame until an inbound message passes this check. Without it, subscribe as
   * soon as the websocket opens.
   */
  readonly subscribeWhen?: (data: unknown) => boolean
  /** Inbound message that marks the protocol handshake as complete. */
  readonly readyWhen?: (data: unknown) => boolean
  /** Close and reconnect when `readyWhen` does not pass within this duration. */
  readonly readyTimeoutMs?: number
  readonly readyTimeoutMessage?: string
  /** Handle one inbound message; call `sink.reportError` for stream-level error frames. */
  readonly onMessage: (data: unknown, sink: ReconnectingSocketErrorSink) => void
  /** Message surfaced when the socket itself errors (connection failure). */
  readonly connectionErrorMessage: string
  readonly onError?: (message: string) => void
  readonly onStateChange?: (state: ReconnectingSocketState) => void
}

export interface ReconnectingSocket {
  /** Sends a message as JSON on the connection open now; false when none is. */
  send(message: unknown): boolean
  /** Stop reconnecting and close the underlying WebSocket. */
  close(): void
}

const INITIAL_STATE: ReconnectingSocketState = {
  connected: false,
  reconnecting: false,
  error: null,
}

export function createReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  const client = options.client ?? generatedClient
  const sharedGrantId = getClientSharedGrantId(client)
  if (sharedGrantId !== null && !options.sharedAccess) {
    options.onError?.(SHARED_ACCESS_REALTIME_UNAVAILABLE)
    options.onStateChange?.({
      connected: false,
      reconnecting: false,
      error: SHARED_ACCESS_REALTIME_UNAVAILABLE,
    })
    return { send: () => false, close: () => undefined }
  }

  const { reconnect = true, reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS } = options
  // Like the session fetch, present the token only to the API the session belongs to.
  const session = getClientSessionAuthority(client)
  const socketSession = session && servesSocket(session.baseUrl, options.url) ? session : null

  let state = INITIAL_STATE
  let stopped = false
  let openedOnce = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectionGeneration = 0
  // Reconnects since the last connection that was ready, for the backoff.
  let failures = 0

  const setState = (next: ReconnectingSocketState) => {
    state = next
    options.onStateChange?.(next)
  }

  const sink: ReconnectingSocketErrorSink = {
    reportError(message: string) {
      options.onError?.(message)
      setState({ ...state, error: message })
    },
  }

  const scheduleReconnect = () => {
    if (!reconnect || stopped || reconnectTimer) return
    const delay = options.maxReconnectDelayMs
      ? Math.min(options.maxReconnectDelayMs, reconnectDelayMs * 2 ** failures)
      : reconnectDelayMs
    failures += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (stopped) return
    const generation = ++connectionGeneration
    setState({ connected: false, reconnecting: openedOnce || state.reconnecting, error: null })

    let protocols: readonly string[] | undefined
    let accessToken: string | null = null
    try {
      if (options.protocols) protocols = await options.protocols()
      // Read on every connection: the token refreshes shortly before it expires, and the server
      // checks it only at the upgrade.
      if (socketSession) {
        accessToken = await getSixbSessionAccessToken(socketSession)
        if (!accessToken) {
          throw new SixbSessionEndedError("[SixbClient] No session is stored. Sign in first.")
        }
      }
    } catch (error) {
      if (stopped || generation !== connectionGeneration) return
      sink.reportError(error instanceof Error ? error.message : String(error))
      const retry =
        reconnect &&
        !(error instanceof SixbSessionEndedError) &&
        (options.shouldReconnectAfterSetupError?.(error) ?? true)
      setState({ connected: false, reconnecting: retry, error: state.error })
      if (retry) scheduleReconnect()
      return
    }
    if (stopped || generation !== connectionGeneration) return

    const ws = openWebSocket(withSharedGrant(options.url, sharedGrantId), protocols, accessToken)
    socket = ws
    let subscribed = false
    let readyTimer: ReturnType<typeof setTimeout> | null = null

    const clearReadyTimer = () => {
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
    }

    const subscribe = () => {
      if (stopped || subscribed || socket !== ws) return
      subscribed = true
      if (options.subscribeMessage) ws.send(JSON.stringify(options.subscribeMessage()))
    }

    ws.onopen = () => {
      if (stopped) return
      openedOnce = true
      if (!options.readyWhen) failures = 0
      setState({ connected: true, reconnecting: false, error: null })
      if (!options.subscribeWhen) subscribe()
      if (options.readyWhen) {
        readyTimer = setTimeout(
          () => {
            if (stopped || socket !== ws) return
            try {
              sink.reportError(
                options.readyTimeoutMessage ?? "Websocket protocol handshake timed out."
              )
            } finally {
              ws.close()
            }
          },
          Math.max(0, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
        )
      }
    }

    ws.onmessage = (messageEvent) => {
      if (stopped) return
      if (options.subscribeWhen?.(messageEvent.data)) subscribe()
      if (options.readyWhen?.(messageEvent.data)) {
        clearReadyTimer()
        failures = 0
      }
      options.onMessage(messageEvent.data, sink)
    }

    ws.onerror = () => {
      if (stopped) return
      sink.reportError(options.connectionErrorMessage)
    }

    ws.onclose = (event?: { readonly code?: number }) => {
      clearReadyTimer()
      if (socket === ws) {
        socket = null
      }
      if (stopped) return

      // The shared link ended: the server would refuse every reconnect.
      if (event?.code === SHARED_ACCESS_ENDED_CLOSE_CODE) {
        stopped = true
        sink.reportError(SHARED_ACCESS_ENDED)
        setState({ connected: false, reconnecting: false, error: SHARED_ACCESS_ENDED })
        return
      }

      setState({ connected: false, reconnecting: reconnect, error: state.error })
      scheduleReconnect()
    }
  }

  void connect()

  return {
    send(message) {
      // 1 is OPEN: read as a number, so a socket that is not the browser's still answers it.
      if (stopped || !socket || socket.readyState !== 1) return false
      socket.send(JSON.stringify(message))
      return true
    },
    close() {
      stopped = true
      connectionGeneration += 1
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      socket?.close()
      socket = null
    },
  }
}

/** The socket's URL naming the shared link's grant, for a shared client; as it is otherwise. */
function withSharedGrant(url: string, grantId: string | null): string {
  if (grantId === null) return url

  const shared = new URL(url)
  shared.searchParams.set("shareGrant", grantId)
  return shared.toString()
}

function servesSocket(apiBaseUrl: string, socketUrl: string): boolean {
  try {
    const api = new URL(apiBaseUrl)
    const socket = new URL(socketUrl)
    return (
      socket.protocol === (api.protocol === "https:" ? "wss:" : "ws:") && socket.host === api.host
    )
  } catch {
    return false
  }
}

// Browsers cannot set WebSocket headers, and never hold a native session. Bun and Node take headers
// in an options object in place of the protocols argument.
type HeaderWebSocketConstructor = new (
  url: string,
  options: { readonly protocols?: string[]; readonly headers: Record<string, string> }
) => WebSocket

function openWebSocket(
  url: string,
  protocols: readonly string[] | undefined,
  accessToken: string | null
): WebSocket {
  if (accessToken) {
    return new (WebSocket as unknown as HeaderWebSocketConstructor)(url, {
      ...(protocols ? { protocols: [...protocols] } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
    })
  }
  return protocols ? new WebSocket(url, [...protocols]) : new WebSocket(url)
}

/** Build the `ws(s)://.../<path>` URL for a Sixb WebSocket stream from the client's API base URL. */
export function createSixbWebSocketUrl(path: string, baseUrl?: string): string {
  const url = new URL(baseUrl ?? generatedClient.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}
