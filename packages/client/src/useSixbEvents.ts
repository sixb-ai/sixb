import { useEffect, useRef, useState } from "react"
import type { SixbEventForSubscription, SixbEventTopic, SixbEventType } from "./events"
import { createEventSocket, eventTypesFromKey } from "./events-transport"

// Re-exported for back-compat: the URL helper now lives with the transport.
export { createSixbEventsWebSocketUrl } from "./events-transport"

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

/**
 * Subscribe to the live event stream, keyed by `topic`/`types`.
 *
 * Thin React wrapper over `createEventSocket`: it keeps `onEvent`/`onError` in
 * refs so handler identity never tears down the socket, mirrors the transport's
 * connection status into component state, and re-subscribes only when the
 * subscription shape changes.
 */
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
    reconnectDelayMs,
  } = options
  const onEventRef = useRef(options.onEvent)
  const onErrorRef = useRef(options.onError)
  // `afterCursor` is read once at connect and then advanced internally by the
  // socket, so it is tracked through a ref and kept out of the dependency list
  // to avoid reconnect churn.
  const afterCursorRef = useRef(afterCursor)
  afterCursorRef.current = afterCursor
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
    if (!enabled) {
      setState({ connected: false, reconnecting: false, error: null })
      return
    }

    const socket = createEventSocket({
      topic,
      types: eventTypesFromKey(typesKey),
      afterCursor: afterCursorRef.current,
      limit,
      reconnect,
      reconnectDelayMs,
      onEvent: (event) => onEventRef.current(event as SixbEventForSubscription<TTopic, TTypes>),
      onError: (message) => onErrorRef.current?.(message),
      onStateChange: setState,
    })

    return () => socket.close()
  }, [enabled, topic, typesKey, limit, reconnect, reconnectDelayMs])

  return state
}
