/**
 * React-free reconnecting WebSocket transport shared by the event and agent-run streams.
 *
 * It owns the whole connection lifecycle — connect, send the subscribe frame, reconnect with
 * backoff, tear down — plus the connected/reconnecting/error state machine. Callers inject the URL,
 * a cursor-aware subscribe payload, and message handling, so each stream keeps its own wire
 * protocol while sharing one reconnection loop. React is an optional peer of `@sixb/client`;
 * nothing here may import it.
 */
import { hasClientSharedAuthority, SHARED_ACCESS_REALTIME_UNAVAILABLE } from "./client-authority"
import { client } from "./generated/client.gen"

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
  /** Built before every connection; useful for one-shot WebSocket tickets. */
  readonly protocols?: () => readonly string[] | Promise<readonly string[]>
  /** Decide whether a failed async connection setup should be retried. */
  readonly shouldReconnectAfterSetupError?: (error: unknown) => boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Built fresh for each subscription so it can carry the latest resume cursor. */
  readonly subscribeMessage: () => unknown
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
  /** Stop reconnecting and close the underlying WebSocket. */
  close(): void
}

const INITIAL_STATE: ReconnectingSocketState = {
  connected: false,
  reconnecting: false,
  error: null,
}

export function createReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  if (hasClientSharedAuthority(client)) {
    options.onError?.(SHARED_ACCESS_REALTIME_UNAVAILABLE)
    options.onStateChange?.({
      connected: false,
      reconnecting: false,
      error: SHARED_ACCESS_REALTIME_UNAVAILABLE,
    })
    return { close: () => undefined }
  }

  const { reconnect = true, reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS } = options

  let state = INITIAL_STATE
  let stopped = false
  let openedOnce = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectionGeneration = 0

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
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, reconnectDelayMs)
  }

  const connect = async () => {
    if (stopped) return
    const generation = ++connectionGeneration
    setState({ connected: false, reconnecting: openedOnce || state.reconnecting, error: null })

    let protocols: readonly string[] | undefined
    try {
      if (options.protocols) protocols = await options.protocols()
    } catch (error) {
      if (stopped || generation !== connectionGeneration) return
      sink.reportError(error instanceof Error ? error.message : String(error))
      const retry = reconnect && (options.shouldReconnectAfterSetupError?.(error) ?? true)
      setState({ connected: false, reconnecting: retry, error: state.error })
      if (retry) scheduleReconnect()
      return
    }
    if (stopped || generation !== connectionGeneration) return

    const ws = protocols ? new WebSocket(options.url, [...protocols]) : new WebSocket(options.url)
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
      ws.send(JSON.stringify(options.subscribeMessage()))
    }

    ws.onopen = () => {
      if (stopped) return
      openedOnce = true
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
      if (options.readyWhen?.(messageEvent.data)) clearReadyTimer()
      options.onMessage(messageEvent.data, sink)
    }

    ws.onerror = () => {
      if (stopped) return
      sink.reportError(options.connectionErrorMessage)
    }

    ws.onclose = () => {
      clearReadyTimer()
      if (socket === ws) {
        socket = null
      }
      if (stopped) return
      setState({ connected: false, reconnecting: reconnect, error: state.error })
      scheduleReconnect()
    }
  }

  void connect()

  return {
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

/** Build the `ws(s)://.../<path>` URL for a Sixb WebSocket stream from the client's API base URL. */
export function createSixbWebSocketUrl(path: string, baseUrl?: string): string {
  const url = new URL(baseUrl ?? client.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}
