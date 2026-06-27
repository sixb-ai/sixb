/**
 * React-free event stream transport (`@sixb/client/events`).
 *
 * `createEventSocket` owns the WebSocket lifecycle the `useSixbEvents` hook used
 * to inline: connect, subscribe, advance the cursor, reconnect, and tear down.
 * It surfaces connection status through an `onStateChange` callback instead of
 * React state, so the same transport backs the builder's `.subscribe()` terminal
 * and the hooks alike. React is an optional peer of `@sixb/client`; nothing here
 * may import it.
 */
import { isSixbEvent, type SixbEvent, type SixbEventTopic, type SixbEventType } from "./events"
import { client } from "./generated/client.gen"

export interface EventSocketState {
  readonly connected: boolean
  readonly reconnecting: boolean
  readonly error: string | null
}

export interface EventSocketOptions {
  readonly topic?: SixbEventTopic
  readonly types?: readonly SixbEventType[]
  /** Object-type scope; the server narrows the stream when set. */
  readonly objectTypeId?: string
  /** Object-instance scope; the server narrows the stream when set. */
  readonly primaryId?: string
  readonly afterCursor?: string
  readonly limit?: number
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Override the API base url. Defaults to the global client config. */
  readonly baseUrl?: string
  readonly onEvent: (event: SixbEvent) => void
  readonly onError?: (error: string) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

export interface EventSocket {
  /** Stop reconnecting and close the underlying WebSocket. */
  close(): void
}

type EventStreamServerMessage =
  | { readonly type: "connected" | "subscribed" | "unsubscribed" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "event"; readonly event: SixbEvent }

const DEFAULT_SIXB_API_BASE_URL = "http://localhost:3002"
const DEFAULT_RECONNECT_DELAY_MS = 1000

const INITIAL_STATE: EventSocketState = { connected: false, reconnecting: false, error: null }

/**
 * Open a subscribing WebSocket to `/ws/events` and stream matching events to
 * `onEvent`. The socket tracks the latest cursor across reconnects so no event
 * is replayed, and matches `topic`/`types` client-side (the server filters by
 * the same fields when they are sent on the subscribe message).
 */
export function createEventSocket(options: EventSocketOptions): EventSocket {
  const {
    topic,
    types,
    objectTypeId,
    primaryId,
    limit,
    reconnect = true,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  } = options

  let state = INITIAL_STATE
  let latestCursor = options.afterCursor
  let stopped = false
  let openedOnce = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const setState = (next: EventSocketState) => {
    state = next
    options.onStateChange?.(next)
  }

  const connect = () => {
    if (stopped) return

    const ws = new WebSocket(createSixbEventsWebSocketUrl(options.baseUrl))
    socket = ws
    setState({ connected: false, reconnecting: openedOnce || state.reconnecting, error: null })

    ws.onopen = () => {
      if (stopped) return

      openedOnce = true
      setState({ connected: true, reconnecting: false, error: null })
      ws.send(
        JSON.stringify({
          type: "subscribe",
          ...(topic ? { topic } : {}),
          ...(types && types.length > 0 ? { types } : {}),
          ...(objectTypeId ? { objectTypeId } : {}),
          ...(primaryId ? { primaryId } : {}),
          ...(latestCursor ? { afterCursor: latestCursor } : {}),
          ...(limit ? { limit } : {}),
        })
      )
    }

    ws.onmessage = (messageEvent) => {
      const message = parseEventStreamMessage(messageEvent.data)
      if (!message) return

      if (message.type === "event") {
        latestCursor = message.event.cursor
        if (matchesSubscription(message.event, topic, types)) {
          options.onEvent(message.event)
        }
        return
      }

      if (message.type === "error") {
        options.onError?.(message.message)
        setState({ ...state, error: message.message })
      }
    }

    ws.onerror = () => {
      const message = "Event websocket connection failed."
      options.onError?.(message)
      setState({ ...state, error: message })
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

export function createSixbEventsWebSocketUrl(baseUrl?: string): string {
  const url = new URL(baseUrl ?? client.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/events"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function parseEventStreamMessage(value: unknown): EventStreamServerMessage | null {
  if (typeof value !== "string") {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null
  }

  if (parsed.type === "event" && isSixbEvent(parsed.event)) {
    return { type: "event", event: parsed.event }
  }

  if (parsed.type === "error") {
    return { type: "error", message: String(parsed.message ?? "Event stream error.") }
  }

  if (
    parsed.type === "connected" ||
    parsed.type === "subscribed" ||
    parsed.type === "unsubscribed"
  ) {
    return { type: parsed.type }
  }

  return null
}

export function eventTypesFromKey(typesKey: string): readonly SixbEventType[] | undefined {
  return typesKey ? (typesKey.split("\0") as SixbEventType[]) : undefined
}

export function matchesSubscription(
  event: SixbEvent,
  topic: SixbEventTopic | undefined,
  types: readonly SixbEventType[] | undefined
): boolean {
  if (topic && event.topic !== topic) {
    return false
  }

  if (types && types.length > 0 && !types.includes(event.type)) {
    return false
  }

  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
