/**
 * React-free reconnecting WebSocket transport shared by the event and agent-run streams.
 *
 * It owns the whole connection lifecycle — connect, send the subscribe frame, reconnect with
 * backoff, tear down — plus the connected/reconnecting/error state machine. Callers inject the URL,
 * a cursor-aware subscribe payload, and message handling, so each stream keeps its own wire
 * protocol while sharing one reconnection loop. React is an optional peer of `@sixb/client`;
 * nothing here may import it.
 */
import { client } from "./generated/client.gen"

const DEFAULT_SIXB_API_BASE_URL = "http://localhost:3002"
const DEFAULT_RECONNECT_DELAY_MS = 1000

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
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Built fresh on each (re)open so it can carry the latest resume cursor. */
  readonly subscribeMessage: () => unknown
  /** Handle one inbound message; call `sink.reportError` for stream-level error frames. */
  readonly onMessage: (data: unknown, sink: ReconnectingSocketErrorSink) => void
  /** Message surfaced when the socket itself errors (connection failure). */
  readonly connectionErrorMessage: string
  readonly onError?: (message: string) => void
  readonly onStateChange?: (state: ReconnectingSocketState) => void
}

export interface ReconnectingSocket {
  /** Stop reconnecting and close the underlying WebSocket. */
  close(): void
}

const INITIAL_STATE: ReconnectingSocketState = {
  connected: false,
  reconnecting: false,
  error: null,
}

export function createReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  const { reconnect = true, reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS } = options

  let state = INITIAL_STATE
  let stopped = false
  let openedOnce = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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

  const connect = () => {
    if (stopped) return

    const ws = new WebSocket(options.url)
    socket = ws
    setState({ connected: false, reconnecting: openedOnce || state.reconnecting, error: null })

    ws.onopen = () => {
      if (stopped) return
      openedOnce = true
      setState({ connected: true, reconnecting: false, error: null })
      ws.send(JSON.stringify(options.subscribeMessage()))
    }

    ws.onmessage = (messageEvent) => {
      if (stopped) return
      options.onMessage(messageEvent.data, sink)
    }

    ws.onerror = () => {
      if (stopped) return
      sink.reportError(options.connectionErrorMessage)
    }

    ws.onclose = () => {
      if (socket === ws) {
        socket = null
      }
      if (stopped) return
      setState({ connected: false, reconnecting: reconnect, error: state.error })
      if (reconnect) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs)
      }
    }
  }

  connect()

  return {
    close() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      socket?.close()
      socket = null
    },
  }
}

/** Build the `ws(s)://.../<path>` URL for a Sixb WebSocket stream from the client's API base URL. */
export function createSixbWebSocketUrl(path: string, baseUrl?: string): string {
  const url = new URL(baseUrl ?? client.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}
