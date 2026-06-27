import { useEffect, useRef, useState } from "react"
import {
  type AgentRunStreamEvent,
  createSixbAgentsWebSocketUrl,
  parseAgentRunStreamServerMessage,
} from "./agent-streams"

export interface UseAgentRunStreamOptions {
  readonly runId?: string | null
  readonly threadId?: string | null
  readonly afterCursor?: string
  readonly enabled?: boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onEvent?: (event: AgentRunStreamEvent, cursor: string) => void
  readonly onError?: (message: string) => void
}

export interface UseAgentRunStreamResult {
  readonly connected: boolean
  readonly reconnecting: boolean
  readonly error: string | null
}

const DEFAULT_RECONNECT_DELAY_MS = 1000

export function useAgentRunStream(options: UseAgentRunStreamOptions): UseAgentRunStreamResult {
  const {
    runId,
    threadId,
    afterCursor,
    enabled = true,
    reconnect = true,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  } = options
  const onEventRef = useRef(options.onEvent)
  const onErrorRef = useRef(options.onError)
  const latestCursorRef = useRef(afterCursor)
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<UseAgentRunStreamResult>({
    connected: false,
    reconnecting: false,
    error: null,
  })

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  useEffect(() => {
    onErrorRef.current = options.onError
  }, [options.onError])

  useEffect(() => {
    latestCursorRef.current = afterCursor

    if (!enabled || !runId) {
      wsRef.current?.close()
      wsRef.current = null
      setState({ connected: false, reconnecting: false, error: null })
      return
    }

    let stopped = false
    let openedOnce = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (stopped) return

      const ws = new WebSocket(createSixbAgentsWebSocketUrl())
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
            runId,
            ...(threadId ? { threadId } : {}),
            ...(latestCursorRef.current ? { afterCursor: latestCursorRef.current } : {}),
          })
        )
      }

      ws.onmessage = (messageEvent) => {
        if (stopped) return

        const message = parseAgentRunStreamServerMessage(messageEvent.data)
        if (!message) return

        if (message.type === "record") {
          latestCursorRef.current = message.record.cursor
          onEventRef.current?.(message.record.payload, message.record.cursor)
          return
        }

        if (message.type === "error") {
          onErrorRef.current?.(message.message)
          setState((current) => ({ ...current, error: message.message }))
        }
      }

      ws.onerror = () => {
        const message = "Agent stream websocket connection failed."
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
  }, [enabled, runId, threadId, afterCursor, reconnect, reconnectDelayMs])

  return state
}
