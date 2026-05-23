import { useEffect, useRef, useState } from "react"
import {
  isSixbEvent,
  type SixbEvent,
  type SixbEventForSubscription,
  type SixbEventTopic,
  type SixbEventType,
} from "./events"
import { client } from "./generated/client.gen"

export interface UseSixbEventsOptions<
  TTopic extends SixbEventTopic | undefined = undefined,
  TTypes extends readonly SixbEventType[] | undefined = undefined,
> {
  readonly topic?: TTopic
  readonly types?: TTypes
  readonly afterCursor?: string
  readonly limit?: number
  readonly enabled?: boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onEvent: (event: SixbEventForSubscription<TTopic, TTypes>) => void
  readonly onError?: (error: string) => void
}

export interface UseSixbEventsResult {
  readonly connected: boolean
  readonly reconnecting: boolean
  readonly error: string | null
}

type EventStreamServerMessage =
  | { readonly type: "connected" | "subscribed" | "unsubscribed" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "event"; readonly event: SixbEvent }

const DEFAULT_SIXB_API_BASE_URL = "http://localhost:3002"
const DEFAULT_RECONNECT_DELAY_MS = 1000

export function useSixbEvents<
  const TTopic extends SixbEventTopic | undefined = undefined,
  const TTypes extends readonly SixbEventType[] | undefined = undefined,
>(options: UseSixbEventsOptions<TTopic, TTypes>): UseSixbEventsResult {
  const {
    topic,
    types,
    afterCursor,
    limit,
    enabled = true,
    reconnect = true,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  } = options
  const onEventRef = useRef(options.onEvent)
  const onErrorRef = useRef(options.onError)
  const latestCursorRef = useRef(afterCursor)
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<UseSixbEventsResult>({
    connected: false,
    reconnecting: false,
    error: null,
  })
  const typesKey = types?.join("\0") ?? ""

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    onErrorRef.current = options.onError
  }, [options.onError])

  useEffect(() => {
    latestCursorRef.current = afterCursor
  }, [afterCursor])

  useEffect(() => {
    if (!enabled) {
      wsRef.current?.close()
      wsRef.current = null
      setState({ connected: false, reconnecting: false, error: null })
      return
    }

    const subscribedTypes = eventTypesFromKey(typesKey)
    let stopped = false
    let openedOnce = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (stopped) return

      const ws = new WebSocket(createSixbEventsWebSocketUrl())
      wsRef.current = ws
      setState((current) => ({
        connected: false,
        reconnecting: openedOnce || current.reconnecting,
        error: null,
      }))

      ws.onopen = () => {
        if (stopped) return

        openedOnce = true
        setState({ connected: true, reconnecting: false, error: null })
        ws.send(
          JSON.stringify({
            type: "subscribe",
            ...(topic ? { topic } : {}),
            ...(subscribedTypes ? { types: subscribedTypes } : {}),
            ...(latestCursorRef.current ? { afterCursor: latestCursorRef.current } : {}),
            ...(limit ? { limit } : {}),
          })
        )
      }

      ws.onmessage = (messageEvent) => {
        const message = parseEventStreamMessage(messageEvent.data)
        if (!message) return

        if (message.type === "event") {
          latestCursorRef.current = message.event.cursor
          if (matchesSubscription(message.event, topic, subscribedTypes)) {
            onEventRef.current(message.event as SixbEventForSubscription<TTopic, TTypes>)
          }
          return
        }

        if (message.type === "error") {
          onErrorRef.current?.(message.message)
          setState((current) => ({ ...current, error: message.message }))
        }
      }

      ws.onerror = () => {
        const message = "Event websocket connection failed."
        onErrorRef.current?.(message)
        setState((current) => ({ ...current, error: message }))
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }

        if (stopped) return

        setState((current) => ({
          connected: false,
          reconnecting: reconnect,
          error: current.error,
        }))

        if (reconnect) {
          reconnectTimer = setTimeout(connect, reconnectDelayMs)
        }
      }
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, topic, typesKey, limit, reconnect, reconnectDelayMs])

  return state
}

export function createSixbEventsWebSocketUrl(baseUrl?: string): string {
  const url = new URL(baseUrl ?? client.getConfig().baseUrl ?? DEFAULT_SIXB_API_BASE_URL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/events"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function parseEventStreamMessage(value: unknown): EventStreamServerMessage | null {
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

function eventTypesFromKey(typesKey: string): readonly SixbEventType[] | undefined {
  return typesKey ? (typesKey.split("\0") as SixbEventType[]) : undefined
}

function matchesSubscription(
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
