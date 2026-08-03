/**
 * React-free event stream transport (exported via `@sixb/client` and `/hooks`).
 *
 * `createEventSocket` owns the full WebSocket lifecycle: connect, subscribe,
 * advance the cursor, reconnect, and tear down.
 * It surfaces connection status through an `onStateChange` callback instead of
 * React state, so the same transport backs the builder's `.subscribe()` terminal
 * and the hooks alike. React is an optional peer of `@sixb/client`; nothing here
 * may import it.
 */
import { isSixbErrorCode, type SixbErrorCode } from "@sixb/core/errors"
import {
  isSixbEvent,
  type SixbEvent,
  type SixbEventTopic,
  type SixbEventType,
} from "./events-model"
import {
  createReconnectingSocket,
  createSixbWebSocketUrl,
  type ReconnectingSocketState,
  type SixbFailure,
} from "./ws-socket"

export type { SixbFailure } from "./ws-socket"

/** Event-level state: `connected` becomes true only after the subscription is acknowledged. */
export type EventSocketState = ReconnectingSocketState

export interface EventSocketOptions {
  readonly topic?: SixbEventTopic
  readonly types?: readonly SixbEventType[]
  /** Object-type scope; the server narrows the stream when set. */
  readonly objectTypeId?: string
  /** Object-instance scope; the server narrows the stream when set. */
  readonly primaryId?: string
  /** Action id scope; the server narrows the stream when set. */
  readonly actionId?: string
  /** Run id scope; the server narrows run/action streams when set. */
  readonly runId?: string
  readonly afterCursor?: string
  readonly limit?: number
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** Maximum time to complete the event protocol handshake. */
  readonly handshakeTimeoutMs?: number
  /** Override the API base url. Defaults to the global client config. */
  readonly baseUrl?: string
  readonly onEvent: (event: SixbEvent) => void
  readonly onError?: (failure: SixbFailure) => void
  readonly onStateChange?: (state: EventSocketState) => void
}

export interface EventSocket {
  /** Stop reconnecting and close the underlying WebSocket. */
  close(): void
}

type EventStreamServerMessage =
  | { readonly type: "connected" | "subscribed" | "unsubscribed" }
  | {
      readonly type: "error"
      /**
       * The failure's code. Branch on it rather than on `message`, which is prose and may be reworded.
       *
       * Falls back to `runtime.unexpected` for a frame that carries no code or one this build does not
       * know — a server older than this client, or newer.
       */
      readonly code: SixbErrorCode
      readonly message: string
    }
  | { readonly type: "event"; readonly event: SixbEvent }

/**
 * Open a subscribing WebSocket to `/ws/events` and stream matching events to
 * `onEvent`. The socket tracks the latest cursor across reconnects so no event
 * is replayed, and matches `topic`/`types` client-side (the server filters by
 * the same fields when they are sent on the subscribe message).
 */
export function createEventSocket(options: EventSocketOptions): EventSocket {
  const { topic, types, objectTypeId, primaryId, actionId, runId, limit } = options
  let latestCursor = options.afterCursor
  let transportState: ReconnectingSocketState = {
    connected: false,
    reconnecting: false,
    error: null,
  }
  let subscribed = false

  const publishState = () => {
    options.onStateChange?.({
      ...transportState,
      connected: transportState.connected && subscribed,
    })
  }

  return createReconnectingSocket({
    url: createSixbEventsWebSocketUrl(options.baseUrl),
    reconnect: options.reconnect,
    reconnectDelayMs: options.reconnectDelayMs,
    readyTimeoutMs: options.handshakeTimeoutMs,
    readyTimeoutMessage: "Event websocket handshake timed out.",
    connectionErrorMessage: "Event websocket connection failed.",
    onError: options.onError,
    onStateChange: (state) => {
      transportState = state
      if (!state.connected) subscribed = false
      publishState()
    },
    subscribeMessage: () => ({
      type: "subscribe",
      ...(topic ? { topic } : {}),
      ...(types && types.length > 0 ? { types } : {}),
      ...(objectTypeId ? { objectTypeId } : {}),
      ...(primaryId ? { primaryId } : {}),
      ...(actionId ? { actionId } : {}),
      ...(runId ? { runId } : {}),
      ...(latestCursor ? { afterCursor: latestCursor } : {}),
      ...(limit ? { limit } : {}),
    }),
    // The event server resolves its initial cursor before announcing readiness.
    // Waiting for that frame prevents subscribe from racing server-side state setup.
    subscribeWhen: (data) => parseEventStreamMessage(data)?.type === "connected",
    readyWhen: (data) => parseEventStreamMessage(data)?.type === "subscribed",
    onMessage: (data, sink) => {
      const message = parseEventStreamMessage(data)
      if (!message) return

      if (message.type === "event") {
        latestCursor = message.event.cursor
        if (matchesSubscription(message.event, topic, types)) {
          options.onEvent(message.event)
        }
        return
      }

      if (message.type === "subscribed") {
        subscribed = true
        publishState()
        return
      }

      if (message.type === "error") {
        sink.reportError({ code: message.code, message: message.message })
      }
    },
  })
}

export function createSixbEventsWebSocketUrl(baseUrl?: string): string {
  return createSixbWebSocketUrl("/ws/events", baseUrl)
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
    return {
      type: "error",
      code: isSixbErrorCode(parsed.code) ? parsed.code : "runtime.unexpected",
      message: String(parsed.message ?? "Event stream error."),
    }
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
