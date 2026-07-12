import { useEffect, useRef, useState } from "react"
import {
  type AgentRunSnapshot,
  type AgentRunStreamEvent,
  createAgentRunSocket,
} from "./agent-streams"
import type { ReconnectingSocketState } from "./ws-socket"

export interface UseAgentRunStreamOptions {
  readonly runId?: string | null
  readonly afterCursor?: string
  readonly enabled?: boolean
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onEvent?: (event: AgentRunStreamEvent, cursor: string) => void
  readonly onRunSnapshot?: (run: AgentRunSnapshot) => void
  readonly onError?: (message: string) => void
}

export type UseAgentRunStreamResult = ReconnectingSocketState

const DISCONNECTED: ReconnectingSocketState = { connected: false, reconnecting: false, error: null }

/**
 * React binding over {@link createAgentRunSocket}: opens the run's stream while enabled and mirrors
 * the transport's connection state into React state. Callbacks are read through refs so re-renders
 * with new callback identities never tear the socket down; the socket is re-created only when a
 * subscription-defining option (runId/afterCursor/enabled/reconnect) changes.
 */
export function useAgentRunStream(options: UseAgentRunStreamOptions): UseAgentRunStreamResult {
  const { runId, afterCursor, enabled = true, reconnect, reconnectDelayMs } = options
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent
  const onSnapshotRef = useRef(options.onRunSnapshot)
  onSnapshotRef.current = options.onRunSnapshot
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError

  const [state, setState] = useState<ReconnectingSocketState>(DISCONNECTED)

  useEffect(() => {
    if (!enabled || !runId) {
      setState(DISCONNECTED)
      return
    }

    const socket = createAgentRunSocket({
      runId,
      ...(afterCursor ? { afterCursor } : {}),
      reconnect,
      reconnectDelayMs,
      onEvent: (event, cursor) => onEventRef.current?.(event, cursor),
      onRunSnapshot: (run) => onSnapshotRef.current?.(run),
      onError: (message) => onErrorRef.current?.(message),
      onStateChange: setState,
    })

    return () => socket.close()
  }, [enabled, runId, afterCursor, reconnect, reconnectDelayMs])

  return state
}
